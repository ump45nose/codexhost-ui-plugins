// Browser-level auto-attach: every Desktop page gets the channel binding and the loader script
// (registered for new documents and evaluated once now); Pet pages get chunk interception.

import { commandWithTimeout, type Cdp, type CdpResult } from "./cdp.ts";
import { type Channel, errorText, type Log } from "./channel.ts";
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
  kind: PageWindow | null;
  focused: boolean | null; // main window only; null until its hello or a focus message arrives
  stale: boolean; // its last hello reported a build other than the one on disk
  scriptRegistered: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Injector {
  #cdp!: Cdp;
  #channel: Channel;
  #log: Log;
  #rewriter: Rewriter;
  #pages = new Map<string, Page>(); // sessionId → page
  #script: string;

  /** One injector serves every Desktop connection in turn: `start(cdp)`, then `dispose()` when it ends. */
  constructor(channel: Channel, log: Log) {
    this.#channel = channel;
    this.#log = log;
    this.#rewriter = new Rewriter((method, params, sid) => this.#cdp.send(method, params, sid), channel, () => void this.reloadPets(), log);
    const registry = channel.registry;
    // Pages navigate between kinds only in theory, but the new-document script is registered
    // before the URL is known (new windows attach at about:blank), so it decides by location.
    this.#script = [
      `switch ((function (href) {${CLASSIFY_BODY}\n})(location.href)) {`,
      `case "main": {\n${registry.script("main")}\n}\nbreak;`,
      `case "pet": {\n${registry.script("pet")}\n}\nbreak;`,
      "}",
    ].join("\n");
    channel.onHello((sid, hello) => {
      const page = this.#pages.get(sid);
      if (!page) return;
      if (page.kind === "main") page.focused = hello.focused;
      page.stale = hello.buildId !== registry.buildId;
      if (page.stale) this.#log(`injector: page ${hello.window} runs build ${hello.buildId}, disk has ${registry.buildId}`);
      void this.#maybeReloadForBuild();
    });
    channel.onFocus((sid, focused) => {
      const page = this.#pages.get(sid);
      if (page?.kind !== "main") return;
      page.focused = focused;
      void this.#maybeReloadForBuild();
    });
  }

  async start(cdp: Cdp): Promise<void> {
    // Keep the safety deadline even with another CDP transport; Rewriter uses this same sender.
    this.#cdp = {
      send: (method, params, sid) => commandWithTimeout(method, cdp.send(method, params, sid)),
      on: (event, handler) => cdp.on(event, handler),
      close: () => cdp.close(),
    };
    cdp.on("Target.attachedToTarget", (p) => void this.#attach(p));
    cdp.on("Target.detachedFromTarget", (p) => this.#detach(p.sessionId));
    cdp.on("Runtime.bindingCalled", (p, sid) => {
      if (sid && p.name === BINDING) this.#channel.handleBinding(sid, p.payload);
    });
    cdp.on("Page.frameNavigated", (p, sid) => {
      if (sid && !p.frame.parentId) void this.#navigated(sid, p.frame.url);
    });
    cdp.on("Page.loadEventFired", (_p, sid) => {
      if (sid && this.#pages.get(sid)?.kind === "pet") this.#rewriter.petLoaded(sid);
    });
    cdp.on("Fetch.requestPaused", (p, sid) => {
      if (sid) void this.#rewriter.requestPaused(sid, p, this.#pages.get(sid)?.kind === "pet");
    });
    // Browser-level auto-attach also attaches the targets that already exist.
    await this.#cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
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
        if (wantFetch && !this.#rewriter.isEnabled(sid)) await this.#rewriter.enable(sid);
        if (!wantFetch && this.#rewriter.isEnabled(sid)) await this.#rewriter.disable(sid);
        await this.#reload(sid);
      } catch (error) {
        this.#log("injector: Pet reload failed:", errorText(error));
      }
    }
  }

  async #attach(p: CdpResult): Promise<void> {
    const sid: string = p.sessionId;
    const { type, url } = p.targetInfo as { type: string; url: string };
    const cdp = this.#cdp;
    const candidate = type === "page" && (url === "" || url === "about:blank" || url.startsWith("app://-/"));
    const attachedAt = Date.now();
    const target = `${p.targetInfo.targetId ?? "unknown"} session=${sid}`;
    this.#log(`injector: target attached ${target} at=${new Date(attachedAt).toISOString()} url=${url || "(blank)"} waiting=${Boolean(p.waitingForDebugger)}`);
    let prepared = candidate ? "failed" : "skipped";
    try {
      if (!candidate) return;
      const kind = classifyUrl(url);
      this.#pages.set(sid, { kind, focused: null, stale: false, scriptRegistered: false });
      if (p.waitingForDebugger && (url === "" || url === "about:blank")) {
        // A new blank renderer may not answer Runtime.enable until it is released. Prepare it
        // afterwards instead of spending the entire command deadline waiting on that cycle.
        prepared = "deferred";
      } else {
        await this.#prepare(cdp, sid, url, Boolean(p.waitingForDebugger));
        prepared = "ready";
      }
    } catch (error) {
      this.#log(`injector: prepare ${target} ${url} failed:`, errorText(error));
    } finally {
      this.#log(`injector: target prepared ${target} at=${new Date().toISOString()} result=${prepared} elapsed=${Date.now() - attachedAt}ms`);
      // Existing targets can already be waiting when the daemon starts or reconnects even if
      // attachedToTarget does not report it. The command is harmless when they are running.
      try {
        await cdp.send("Runtime.runIfWaitingForDebugger", {}, sid);
        this.#log(`injector: target released ${target} at=${new Date().toISOString()} elapsed=${Date.now() - attachedAt}ms`);
      } catch (error) {
        this.#log(`injector: target release failed ${target} at=${new Date().toISOString()}:`, errorText(error));
        try {
          // Detach is handled in the browser and clears its startup throttle even when the
          // target cannot answer Runtime commands. Other attached pages can keep running.
          await cdp.send("Target.detachFromTarget", { sessionId: sid });
          if (this.#cdp === cdp) this.#detach(sid);
          this.#log(`injector: target released ${target} at=${new Date().toISOString()} recovery=detach elapsed=${Date.now() - attachedAt}ms`);
        } catch (detachError) {
          // Dropping the debugger connection detaches all its targets. main.ts then discovers
          // Desktop again; do not keep the connection that may still be holding startup.
          this.#log(`injector: target detach failed ${target} at=${new Date().toISOString()}, closing debugger connection:`, errorText(detachError));
          if (this.#cdp === cdp) this.dispose();
          cdp.close();
        }
      }
    }
    if ((prepared === "failed" || prepared === "deferred") && this.#cdp === cdp && this.#pages.has(sid)) {
      try {
        await this.#prepare(cdp, sid, url, false, true);
        prepared = "recovered";
        this.#log(`injector: target injected ${target} at=${new Date().toISOString()} after-release elapsed=${Date.now() - attachedAt}ms`);
      } catch (error) {
        this.#log(`injector: injection after release failed ${target} at=${new Date().toISOString()}:`, errorText(error));
      }
    }
    // A Pet loaded before we attached ran its chunks unrewritten: load it again.
    if (this.#pages.get(sid)?.kind === "pet" && (prepared === "recovered" || !p.waitingForDebugger) && this.#rewriter.isEnabled(sid)) {
      await this.#reload(sid).catch((error) => this.#log("injector: Pet reload failed:", errorText(error)));
    }
  }

  async #prepare(cdp: Cdp, sid: string, url: string, waiting: boolean, afterRelease = false): Promise<void> {
    const send = (method: string, params: object = {}) => cdp.send(method, params, sid);
    // Without Runtime.enable the binding is gone after the next reload.
    await send("Runtime.enable");
    await send("Runtime.addBinding", { name: BINDING });
    await send("Page.enable");
    if (afterRelease) {
      // Navigation may have finished before Page.enable, so waiting for frameNavigated alone
      // would leave an already complete Pet unclassified and its loader unevaluated.
      const { frameTree } = await send("Page.getFrameTree");
      url = frameTree?.frame?.url ?? url;
      await this.#navigated(sid, url);
    }
    const page = this.#pages.get(sid);
    if (!page || this.#cdp !== cdp) return;
    const mayBePet = page.kind === "pet" || (page.kind === null && !url.startsWith("app://"));
    if (mayBePet && this.#channel.registry.hasEnabledRewrites() && !this.#rewriter.isEnabled(sid)) await this.#rewriter.enable(sid);
    if (!page.scriptRegistered) {
      await send("Page.addScriptToEvaluateOnNewDocument", { source: this.#script });
      page.scriptRegistered = true;
    }
    if (page.kind) this.#addToChannel(sid, page.kind);
    if (page.kind && !waiting) {
      const result = await send("Runtime.evaluate", { expression: this.#script });
      if (result.exceptionDetails) this.#log(`injector: script threw in ${page.kind}:`, result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
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
      if (kind !== "pet" && this.#rewriter.isEnabled(sid)) await this.#rewriter.disable(sid);
    }
    if (kind === "pet") this.#rewriter.petNavigated(sid);
  }

  #addToChannel(sid: string, kind: PageWindow): void {
    this.#channel.addPage(sid, kind, (expression) => this.#cdp.send("Runtime.evaluate", { expression }, sid));
  }

  #detach(sid: string): void {
    if (!this.#pages.delete(sid)) return;
    this.#channel.removePage(sid);
    this.#rewriter.pageClosed(sid);
  }

  /** A page runs an older build: reload all pages, but only while every main window is known to be in the background. */
  async #maybeReloadForBuild(): Promise<void> {
    const pages = [...this.#pages].filter(([, p]) => p.kind);
    const mains = pages.filter(([, p]) => p.kind === "main");
    if (!pages.some(([, p]) => p.stale) || !mains.length || mains.some(([, p]) => p.focused !== false)) return;
    // The reloaded documents report their build and focus again in their hello.
    for (const [, page] of pages) Object.assign(page, { stale: false, focused: null });
    for (const [sid, page] of pages) {
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
