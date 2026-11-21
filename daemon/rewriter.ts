// Pet chunk rewriting: Fetch interception at the response stage, plugin rules applied in order.

import type { Cdp, CdpResult } from "./cdp.ts";
import { type Channel, errorText, type Log } from "./channel.ts";
import type { Registry } from "./registry.ts";
import { hasPetForkRewrite } from "../plugins/pet/rewrites.ts";

const IDENTIFY_TIMEOUT_MS = 10_000;

interface PetLoad {
  identified: Map<string, Set<number>>; // recognised rule indices by plugin in this document
  failed: Set<string>; // plugins that failed in this document (their rules are skipped)
  dormant: Set<string>; // plugins superseded by fork rewrites in this document
  timer?: ReturnType<typeof setTimeout>;
}

export class Rewriter {
  #send: Cdp["send"];
  #registry: Registry;
  #channel: Channel;
  #log: Log;
  #reloadPets: () => void;
  #loads = new Map<string, PetLoad>(); // Pet session → current document

  constructor(send: Cdp["send"], channel: Channel, reloadPets: () => void, log: Log) {
    this.#send = send;
    this.#channel = channel;
    this.#registry = channel.registry;
    this.#reloadPets = reloadPets;
    this.#log = log;
    channel.onPluginChange((id, change) => {
      if (!this.#registry.get(id)?.rewrites.length) return;
      // Enabling/disabling changes which chunks get rewritten, so Pet must load again. Retry of a
      // rewriter failure means trying the rules again, which also needs a fresh Pet load.
      if (change === "enabled" || (change === "retry" && channel.statusOf(id, "rewriter") === "failed")) {
        this.#reloadPets();
      }
    });
  }

  /** Must run before the page loads its scripts. Cached scripts would bypass interception. */
  async enable(sessionId: string): Promise<void> {
    // The cache switch only takes effect while the Network domain is enabled in this session.
    await this.#send("Network.enable", {}, sessionId);
    await this.#send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
    await this.#send(
      "Fetch.enable",
      { patterns: [{ urlPattern: "*", resourceType: "Script", requestStage: "Response" }] },
      sessionId,
    );
    this.#loads.set(sessionId, { identified: new Map(), failed: new Set(), dormant: new Set() });
  }

  async disable(sessionId: string): Promise<void> {
    this.pageClosed(sessionId);
    await this.#send("Fetch.disable", {}, sessionId).catch(() => undefined);
    await this.#send("Network.disable", {}, sessionId).catch(() => undefined);
  }

  isEnabled(sessionId: string): boolean {
    return this.#loads.has(sessionId);
  }

  /** A Pet page committed a new document: earlier rewriter verdicts no longer apply. */
  petNavigated(sessionId: string): void {
    const load = this.#loads.get(sessionId);
    if (!load) return;
    clearTimeout(load.timer);
    this.#loads.set(sessionId, { identified: new Map(), failed: new Set(), dormant: new Set() });
    for (const p of this.#registry.plugins) {
      if (this.#channel.statusOf(p.id, "rewriter")) this.#channel.setStatus(p.id, "rewriter", null);
    }
  }

  /** Pet `Page.loadEventFired`: each rewrite rule must recognise a chunk within the timeout. */
  petLoaded(sessionId: string): void {
    const load = this.#loads.get(sessionId);
    if (!load) return;
    clearTimeout(load.timer);
    load.timer = setTimeout(() => {
      for (const p of this.#registry.plugins) {
        if (!p.enabled || !p.rewrites.length || load.failed.has(p.id) || load.dormant.has(p.id)) continue;
        const names = p.rewrites.filter((_, index) => !load.identified.get(p.id)?.has(index)).map((r) => r.name).join(", ");
        if (!names) continue;
        this.#fail(load, p.id, `no Pet chunk matched rewrite rule(s) ${names} within ${IDENTIFY_TIMEOUT_MS / 1000} s of load`);
      }
    }, IDENTIFY_TIMEOUT_MS);
  }

  pageClosed(sessionId: string): void {
    clearTimeout(this.#loads.get(sessionId)?.timer);
    this.#loads.delete(sessionId);
  }

  /** Handles `Fetch.requestPaused`. The request is always fulfilled or continued. */
  async requestPaused(sessionId: string, params: CdpResult, isPet: boolean): Promise<void> {
    const requestId: string = params.requestId;
    try {
      const load = this.#loads.get(sessionId);
      const status: number = params.responseStatusCode ?? 0;
      if (isPet && load && status >= 200 && status < 300) {
        const body = await this.#send("Fetch.getResponseBody", { requestId }, sessionId);
        const source = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : String(body.body);
        const rewritten = this.#rewrite(load, source);
        if (rewritten !== source) {
          const headers = ((params.responseHeaders ?? []) as Array<{ name: string; value: string }>).filter(
            (h) => h.name.toLowerCase() !== "content-length",
          );
          await this.#send(
            "Fetch.fulfillRequest",
            { requestId, responseCode: status, responseHeaders: headers, body: Buffer.from(rewritten).toString("base64") },
            sessionId,
          );
          return;
        }
      }
    } catch (error) {
      this.#log(`rewriter: ${params.request?.url}:`, errorText(error));
    }
    await this.#send("Fetch.continueRequest", { requestId }, sessionId).catch(() => undefined);
  }

  /** Runs every enabled plugin's rules over one chunk. A plugin that fails keeps none of its edits. */
  #rewrite(load: PetLoad, source: string): string {
    let current = source;
    for (const p of this.#registry.plugins) {
      if (!p.enabled || !p.rewrites.length) continue;
      if (p.id === "pet" && hasPetForkRewrite(source)) {
        load.dormant.add(p.id);
        load.failed.delete(p.id);
        this.#channel.setStatus(p.id, "rewriter", null);
        // The page loader watches this separate marker; do not change the fork's own globals.
        current = `${current}\n;globalThis.__cxpPetForkRewriteDetected=true;`;
      }
      if (load.failed.has(p.id) || load.dormant.has(p.id)) continue;
      let next = current;
      let failure: string | null = null;
      for (const [index, rule] of p.rewrites.entries()) {
        try {
          if (!rule.identify(next)) continue;
          if (!load.identified.has(p.id)) load.identified.set(p.id, new Set());
          load.identified.get(p.id)!.add(index);
          const applied = rule.apply(next);
          if (applied === null) {
            failure = `rewrite rule ${rule.name} recognised a Pet chunk but could not apply`;
            break;
          }
          next = applied;
        } catch (error) {
          failure = `rewrite rule ${rule.name} threw: ${errorText(error)}`;
          break;
        }
      }
      if (failure) this.#fail(load, p.id, failure);
      else current = next;
    }
    return current;
  }

  #fail(load: PetLoad, plugin: string, reason: string): void {
    load.failed.add(plugin);
    this.#log(`rewriter: ${plugin} failed: ${reason}`);
    this.#channel.setStatus(plugin, "rewriter", "failed", reason);
  }
}
