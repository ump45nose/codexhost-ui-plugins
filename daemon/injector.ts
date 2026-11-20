// Browser-level auto-attach: every Desktop page gets the channel binding and the loader script
// (registered for new documents and evaluated once now); Pet pages get chunk interception.

import type { Cdp, CdpResult } from "./cdp.ts";
import type { Channel, Log } from "./channel.ts";
import type { PageWindow } from "./registry.ts";
import { Rewriter } from "./rewriter.ts";

export const BINDING = "__cxpDaemon";

// Shared by the daemon and the injected script, so both classify pages the same way. The main
// window is `app://-/index.html`; Pet is the same page opened with `initialRoute=/avatar-overlay`.
const CLASSIFY_BODY = `
  if (typeof href !== "string" || !href.startsWith("app://-/index.html")) return null;
  var route = new URL(href).searchParams.get("initialRoute");
  if (route === null) return "main";
  return route === "/avatar-overlay" || route.startsWith("/avatar-overlay?") || route.startsWith("/avatar-overlay/") ? "pet" : null;`;
export const classifyUrl = new Function("href", CLASSIFY_BODY) as (href: string) => PageWindow | null;

interface Page {
  targetId: string;
  kind: PageWindow | null;
  focused: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Injector {
  readonly rewriter: Rewriter;
  #cdp: Cdp;
  #channel: Channel;
  #log: Log;
  #pages = new Map<string, Page>(); // sessionId → page
  #petReloaded = new Set<string>(); // targetIds reloaded at attach (once per daemon run)
  #buildReloaded = new Set<string>(); // targetIds reloaded for a stale buildId
  #buildReloadPending = false;
  #script: string;

  constructor(cdp: Cdp, channel: Channel, log: Log, rewriter?: Rewriter) {
    this.#cdp = cdp;
    this.#channel = channel;
    this.#log = log;
    this.rewriter = rewriter ?? new Rewriter(cdp, channel, () => void this.reloadPets(), log);
    const registry = channel.registry;
    // Pages navigate between kinds only in theory, but the new-document script is registered
    // before the URL is known (new windows attach at about:blank), so it decides by location.
    this.#script = [
      `switch ((function (href) {${CLASSIFY_BODY}\n})(location.href)) {`,
      `case "main": {\n${registry.script("main")}\n}\nbreak;`,
      `case "pet": {\n${registry.script("pet")}\n}\nbreak;`,
      "}",
    ].join("\n");
  }

  async start(): Promise<void> {
    const cdp = this.#cdp;
    cdp.on("Target.attachedToTarget", (p) => void this.#attach(p));
    cdp.on("Target.detachedFromTarget", (p) => this.#detach(p.sessionId));
    cdp.on("Runtime.bindingCalled", (p, sid) => {
      if (sid && p.name === BINDING) this.#channel.handleBinding(sid, p.payload);
    });
    cdp.on("Page.frameNavigated", (p, sid) => {
      if (sid && !p.frame.parentId) void this.#navigated(sid, p.frame.url);
    });
    cdp.on("Page.loadEventFired", (_p, sid) => {
      if (sid && this.#pages.get(sid)?.kind === "pet") this.rewriter.petLoaded(sid);
    });
    cdp.on("Fetch.requestPaused", (p, sid) => {
      if (sid) void this.rewriter.requestPaused(sid, p, this.#pages.get(sid)?.kind === "pet");
    });
    this.#channel.onHello((sid, hello) => {
      const page = this.#pages.get(sid);
      if (!page) return;
      if (page.kind === "main") page.focused = hello.focused;
      if (hello.buildId !== this.#channel.registry.buildId && !this.#buildReloaded.has(page.targetId)) {
        this.#log(`injector: page ${hello.window} runs build ${hello.buildId}, disk has ${this.#channel.registry.buildId}`);
        this.#buildReloadPending = true;
      }
      void this.#maybeReloadForBuild();
    });
    this.#channel.onFocus((sid, focused) => {
      const page = this.#pages.get(sid);
      if (page?.kind !== "main") return;
      page.focused = focused;
      void this.#maybeReloadForBuild();
    });
    // Browser-level auto-attach also attaches the targets that already exist.
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  /** The connection is gone: forget every page. */
  dispose(): void {
    for (const sid of [...this.#pages.keys()]) this.#detach(sid);
  }

  /** Reloads every Pet page (after rewrite rules were switched on or off, or a rewriter retry). */
  async reloadPets(): Promise<void> {
    const wantFetch = this.#channel.registry.hasEnabledRewrites();
    for (const [sid, page] of this.#pages) {
      if (page.kind !== "pet") continue;
      try {
        if (wantFetch && !this.rewriter.isEnabled(sid)) await this.rewriter.enable(sid);
        if (!wantFetch && this.rewriter.isEnabled(sid)) await this.rewriter.disable(sid);
        await this.#reload(sid);
      } catch (error) {
        this.#log("injector: Pet reload failed:", errorText(error));
      }
    }
  }

  async #attach(p: CdpResult): Promise<void> {
    const sid: string = p.sessionId;
    const { type, url, targetId } = p.targetInfo as { type: string; url: string; targetId: string };
    const candidate = type === "page" && (url === "" || url === "about:blank" || url.startsWith("app://-/"));
    try {
      if (!candidate) return;
      const kind = classifyUrl(url);
      this.#pages.set(sid, { targetId, kind, focused: false });
      const send = (method: string, params: object = {}) => this.#cdp.send(method, params, sid);
      // Without Runtime.enable the binding is gone after the next reload.
      await send("Runtime.enable");
      await send("Runtime.addBinding", { name: BINDING });
      await send("Page.enable");
      const mayBePet = kind === "pet" || (kind === null && !url.startsWith("app://"));
      if (mayBePet && this.#channel.registry.hasEnabledRewrites()) await this.rewriter.enable(sid);
      await send("Page.addScriptToEvaluateOnNewDocument", { source: this.#script });
      if (kind) this.#addToChannel(sid, kind);
      if (kind && !p.waitingForDebugger) {
        const result = await send("Runtime.evaluate", { expression: this.#script });
        if (result.exceptionDetails) this.#log(`injector: script threw in ${kind}:`, result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      }
      this.#log(`injector: attached ${kind ?? "unclassified page"} ${url || "(blank)"}`);
    } catch (error) {
      this.#log(`injector: attach ${url} failed:`, errorText(error));
    } finally {
      if (p.waitingForDebugger) await this.#cdp.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => undefined);
    }
    const page = this.#pages.get(sid);
    // A Pet loaded before we attached ran its chunks unrewritten: load it again, once.
    if (page?.kind === "pet" && !p.waitingForDebugger && this.rewriter.isEnabled(sid) && !this.#petReloaded.has(targetId)) {
      this.#petReloaded.add(targetId);
      await this.#reload(sid).catch((error) => this.#log("injector: Pet reload failed:", errorText(error)));
    }
  }

  async #navigated(sid: string, url: string): Promise<void> {
    const page = this.#pages.get(sid);
    if (!page) return;
    const kind = classifyUrl(url);
    if (kind !== page.kind) {
      page.kind = kind;
      if (kind) this.#addToChannel(sid, kind);
      else this.#channel.removePage(sid);
      if (kind !== "pet" && this.rewriter.isEnabled(sid)) await this.rewriter.disable(sid);
    }
    if (kind === "pet") this.rewriter.petNavigated(sid);
  }

  #addToChannel(sid: string, kind: PageWindow): void {
    this.#channel.addPage(sid, kind, (expression) => this.#cdp.send("Runtime.evaluate", { expression }, sid));
  }

  #detach(sid: string): void {
    if (!this.#pages.delete(sid)) return;
    this.#channel.removePage(sid);
    this.rewriter.pageClosed(sid);
  }

  /** A page runs an older build: reload all pages, but only while the main window is in the background. */
  async #maybeReloadForBuild(): Promise<void> {
    if (!this.#buildReloadPending) return;
    if ([...this.#pages.values()].some((p) => p.kind === "main" && p.focused)) return;
    this.#buildReloadPending = false;
    for (const [sid, page] of this.#pages) {
      if (!page.kind || this.#buildReloaded.has(page.targetId)) continue;
      this.#buildReloaded.add(page.targetId);
      this.#log(`injector: reloading ${page.kind} for build ${this.#channel.registry.buildId}`);
      await this.#reload(sid).catch((error) => this.#log("injector: reload failed:", errorText(error)));
    }
  }

  /** Desktop keeps a reloaded Pet hidden, so a Pet that was showing is asked to open again. */
  async #reload(sid: string): Promise<void> {
    const isPet = this.#pages.get(sid)?.kind === "pet";
    const visible = isPet && (await this.#evaluate(sid, "document.visibilityState === 'visible'")) === true;
    await this.#cdp.send("Page.reload", {}, sid);
    if (!visible) return;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(1000);
      if (!this.#pages.has(sid)) return;
      if ((await this.#evaluate(sid, "document.visibilityState === 'visible'").catch(() => true)) === true) return;
      const main = [...this.#pages].find(([, p]) => p.kind === "main")?.[0];
      if (main) {
        await this.#evaluate(main, "void window.electronBridge?.sendMessageFromView?.({ type: 'avatar-overlay-open' })").catch(() => undefined);
      }
    }
  }

  async #evaluate(sid: string, expression: string): Promise<unknown> {
    const result = await this.#cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sid);
    return result.result?.value;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
