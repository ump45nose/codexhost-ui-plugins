// Page channel: messages from `__cxpDaemon(json)` bindings, state pushed back through
// `window.__cxpReceive(json)`, plugin status recorded per source and aggregated.

import type { PluginStatus } from "../plugins/types.ts";
import type { PageWindow, Registry } from "./registry.ts";

export type Log = (...args: unknown[]) => void;
export type RequestHandler = (params: unknown) => Promise<unknown>;
export type PluginChange = "enabled" | "settings" | "retry";
export type StatusSource = "rewriter" | "task";

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface UpdateState {
  checkedAt: string | null;
  error?: string;
}

export interface Hello {
  window: PageWindow;
  buildId: string;
  focused: boolean;
}

interface Page {
  window: PageWindow;
  evaluate(expression: string): Promise<unknown>;
  lastSent: string | null;
}

interface SourceStatus {
  state: PluginStatus;
  reason?: string;
  source: string; // shown to the page: "rewriter", "task", or the page's window
}

type Message =
  | ({ type: "hello" } & Hello)
  | { type: "status"; plugin: string; state: PluginStatus; reason?: string }
  | { type: "focus"; focused: boolean }
  | { type: "settings:set"; plugin: string; values: Record<string, unknown> }
  | { type: "enable"; plugin: string; enabled: boolean }
  | { type: "retry"; plugin: string }
  | { type: "request"; id: string | number; plugin: string; method: string; params?: unknown };

const SOURCE_ORDER = (key: string) => (key === "rewriter" ? 0 : key === "task" ? 1 : 2);

export class Channel {
  readonly registry: Registry;
  #log: Log;
  #pages = new Map<string, Page>();
  #statuses = new Map<string, Map<string, SourceStatus>>(); // plugin → source key → status
  #handlers = new Map<string, RequestHandler>();
  #changeListeners: Array<(plugin: string, change: PluginChange) => void> = [];
  #helloListeners: Array<(sessionId: string, hello: Hello) => void> = [];
  #focusListeners: Array<(sessionId: string, focused: boolean) => void> = [];
  #update: UpdateState = { checkedAt: null };
  #pushScheduled = false;

  constructor(registry: Registry, log: Log) {
    this.registry = registry;
    this.#log = log;
  }

  // ---- for tasks (W1.3) and the rewriter ----

  /** Serves page `request { plugin, method }` messages. Returns an unregister function. */
  onRequest(plugin: string, method: string, handler: RequestHandler): () => void {
    const key = `${plugin}\0${method}`;
    this.#handlers.set(key, handler);
    return () => {
      if (this.#handlers.get(key) === handler) this.#handlers.delete(key);
    };
  }

  /** Records a non-page source's status for a plugin; `null` clears it. Pushes state. */
  setStatus(plugin: string, source: StatusSource, state: PluginStatus | null, reason?: string): void {
    this.#setStatus(plugin, source, state === null ? null : { state, reason, source });
  }

  statusOf(plugin: string, source: StatusSource): PluginStatus | null {
    return this.#statuses.get(plugin)?.get(source)?.state ?? null;
  }

  /** Called after a plugin's enabled flag or settings were changed from a page, or on `retry`. */
  onPluginChange(listener: (plugin: string, change: PluginChange) => void): void {
    this.#changeListeners.push(listener);
  }

  // ---- for the updater (W1.4) ----

  setUpdate(update: UpdateState): void {
    this.#update = update;
    this.#schedulePush();
  }

  // ---- for the injector ----

  onHello(listener: (sessionId: string, hello: Hello) => void): void {
    this.#helloListeners.push(listener);
  }

  onFocus(listener: (sessionId: string, focused: boolean) => void): void {
    this.#focusListeners.push(listener);
  }

  /** Registers a page and pushes state to it (a loader that is already running gets it too). */
  addPage(sessionId: string, window: PageWindow, evaluate: (expression: string) => Promise<unknown>): void {
    this.#pages.set(sessionId, { window, evaluate, lastSent: null });
    this.#schedulePush();
  }

  removePage(sessionId: string): void {
    this.#pages.delete(sessionId);
    this.#clearPageStatuses(sessionId);
  }

  handleBinding(sessionId: string, payload: string): void {
    const page = this.#pages.get(sessionId);
    if (!page) return;
    let msg: Message;
    try {
      msg = JSON.parse(payload) as Message;
    } catch {
      this.#log("channel: ignoring malformed message", payload.slice(0, 200));
      return;
    }
    try {
      this.#handle(sessionId, page, msg);
    } catch (error) {
      this.#log(`channel: ${msg.type} failed:`, errorText(error));
    }
  }

  /** The state message as pushed to pages. */
  state(): object {
    return {
      type: "state",
      buildId: this.registry.buildId,
      plugins: this.registry.plugins.map((p) => {
        const status = this.aggregate(p.id);
        return {
          id: p.id,
          name: p.name,
          enabled: p.enabled,
          settings: p.settings,
          settingFields: p.settingFields,
          ...status,
        };
      }),
      update: this.#update,
    };
  }

  /**
   * Disabled → off. Any failed source → failed with that source and reason (daemon sources
   * first). Otherwise active if any page reports active, dormant if a page reports only dormant,
   * and active when nothing objects (e.g. a task-only plugin, or no page loaded yet).
   */
  aggregate(plugin: string): { status: PluginStatus; source?: string; reason?: string } {
    if (!this.registry.get(plugin)?.enabled) return { status: "off" };
    const entries = [...(this.#statuses.get(plugin) ?? new Map<string, SourceStatus>())].sort(
      ([a], [b]) => SOURCE_ORDER(a) - SOURCE_ORDER(b),
    );
    const failed = entries.find(([, s]) => s.state === "failed");
    if (failed) return { status: "failed", source: failed[1].source, reason: failed[1].reason };
    const states = entries.map(([, s]) => s.state);
    if (!states.includes("active") && states.includes("dormant")) return { status: "dormant" };
    return { status: "active" };
  }

  #handle(sessionId: string, page: Page, msg: Message): void {
    switch (msg.type) {
      case "hello":
        // A hello starts a new document: forget what the previous one reported.
        page.lastSent = null;
        this.#clearPageStatuses(sessionId);
        for (const l of this.#helloListeners) l(sessionId, msg);
        this.#schedulePush();
        return;
      case "focus":
        for (const l of this.#focusListeners) l(sessionId, msg.focused);
        return;
      case "status":
        if (!this.registry.get(msg.plugin)) return;
        this.#setStatus(msg.plugin, `page:${sessionId}`, {
          state: msg.state,
          reason: msg.reason,
          source: page.window,
        });
        return;
      case "enable":
        this.registry.setEnabled(msg.plugin, msg.enabled === true);
        this.#changed(msg.plugin, "enabled");
        return;
      case "settings:set":
        this.registry.setSettings(msg.plugin, msg.values ?? {});
        this.#changed(msg.plugin, "settings");
        return;
      case "retry": {
        // Page-session failures are cleared here, and pages that failed the plugin re-run it once
        // the pushed aggregate is no longer failed. The task listener restarts a failed task; a
        // rewriter failure stays until the Pet reload the rewriter starts on "retry".
        if (!this.registry.get(msg.plugin)) return;
        const statuses = this.#statuses.get(msg.plugin);
        for (const [key, s] of statuses ?? []) if (key.startsWith("page:") && s.state === "failed") statuses!.delete(key);
        this.#changed(msg.plugin, "retry");
        return;
      }
      case "request":
        void this.#serve(page, msg);
        return;
      default:
        this.#log("channel: unknown message type", (msg as { type?: unknown }).type);
    }
  }

  async #serve(page: Page, msg: Extract<Message, { type: "request" }>): Promise<void> {
    const handler = this.#handlers.get(`${msg.plugin}\0${msg.method}`);
    let reply: object;
    if (!handler) reply = { type: "response", id: msg.id, error: `no handler for ${msg.plugin}.${msg.method}` };
    else {
      try {
        reply = { type: "response", id: msg.id, result: (await handler(msg.params)) ?? null };
      } catch (error) {
        reply = { type: "response", id: msg.id, error: errorText(error) };
      }
    }
    await this.#send(page, JSON.stringify(reply));
  }

  #changed(plugin: string, change: PluginChange): void {
    for (const l of this.#changeListeners) l(plugin, change);
    this.#schedulePush();
  }

  #setStatus(plugin: string, key: string, status: SourceStatus | null): void {
    let map = this.#statuses.get(plugin);
    if (!map) this.#statuses.set(plugin, (map = new Map()));
    if (status) map.set(key, status);
    else map.delete(key);
    this.#schedulePush();
  }

  #clearPageStatuses(sessionId: string): void {
    for (const map of this.#statuses.values()) map.delete(`page:${sessionId}`);
    this.#schedulePush();
  }

  /** Coalesces bursts (e.g. one status per plugin at page start) into one push per page. */
  #schedulePush(): void {
    if (this.#pushScheduled) return;
    this.#pushScheduled = true;
    setImmediate(() => {
      this.#pushScheduled = false;
      const json = JSON.stringify(this.state());
      for (const page of this.#pages.values()) {
        if (page.lastSent === json) continue;
        page.lastSent = json;
        void this.#send(page, json);
      }
    });
  }

  async #send(page: Page, json: string): Promise<void> {
    try {
      await page.evaluate(`window.__cxpReceive?.(${json})`);
    } catch (error) {
      this.#log("channel: push failed:", errorText(error));
    }
  }
}
