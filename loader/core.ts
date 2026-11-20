// Page-side loader: talks to the daemon over the page channel, starts each plugin in isolation,
// puts plugins to sleep while a fork guard is present, and exposes window.__cxpLoaderV1.
import type { PluginApi, PluginStatus, SettingField } from "../plugins/types.ts";
import { clearFailureNotice, showFailureNotice } from "./ui/notice.ts";

export type WindowKind = "main" | "pet";
export type Activate = (api: PluginApi) => void | (() => void);

export interface DaemonPlugin {
  id: string;
  name: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  settingFields: SettingField[];
  status: PluginStatus;
  source?: string;
  reason?: string;
}

export interface DaemonState {
  buildId: string;
  plugins: DaemonPlugin[];
  update: { checkedAt: unknown; error?: string };
}

export interface LoaderState {
  window: WindowKind;
  buildId: string;
  /** Last state pushed by the daemon (aggregate over all sources); null until the first push. */
  daemon: DaemonState | null;
  /** Status of the plugins loaded in this page. */
  local: Record<string, { status: PluginStatus; reason?: string }>;
}

export interface LoaderV1 {
  window: WindowKind;
  getState(): LoaderState;
  subscribe(listener: (state: LoaderState) => void): () => void;
  setEnabled(id: string, on: boolean): void;
  setSettings(id: string, values: Record<string, unknown>): void;
  retry(id: string): void;
}

export interface LoaderWindow {
  document: Document;
  addEventListener(type: string, listener: () => void): void;
  [key: string]: any;
}

interface Slot {
  id: string;
  activate: Activate;
  forkGuards: string[];
  status?: PluginStatus;
  reason?: string;
  running: boolean;
  cleanup?: () => void;
  settingsKey?: string;
  /** Bumped on every start/stop so a stale api.fail from an earlier activation is ignored. */
  gen: number;
  /** Failed in this page (throw or api.fail); cleared by retry, disable, or the daemon clearing it. */
  failed: boolean;
  fastUntil: number;
  nextGuardCheck: number;
}

/** Status sources that are not page sessions; their failures stop the plugin in every page. */
const NON_PAGE_SOURCES = new Set(["rewriter", "task"]);
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;
const GUARD_FAST_MS = 1_000;
const GUARD_FAST_WINDOW_MS = 15_000;
const GUARD_SLOW_MS = 10_000;
const SEND_RETRY_MS = 250;

export function startLoader(win: LoaderWindow, buildId: string): void {
  // The daemon registers the script for new documents and also evaluates it once on a loaded page.
  if (win.__cxpLoaderV1) {
    win.__cxpLoaderResync?.();
    return;
  }
  const kind: WindowKind = win.__cxpWindow === "pet" ? "pet" : "main";
  const doc = win.document;
  const slots = new Map<string, Slot>();
  const listeners = new Set<(state: LoaderState) => void>();
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const outbox: string[] = [];
  let daemon: DaemonState | null = null;
  let ready = false;
  let requestSeq = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  // ---- channel ----
  function send(msg: Record<string, unknown>): void {
    outbox.push(JSON.stringify(msg));
    flush();
  }
  function flush(): void {
    const bind = win.__cxpDaemon;
    if (typeof bind !== "function") {
      flushTimer ??= setTimeout(() => {
        flushTimer = undefined;
        flush();
      }, SEND_RETRY_MS);
      return;
    }
    while (outbox.length) {
      try {
        bind(outbox.shift());
      } catch (error) {
        console.warn("[cxp] send failed", error);
      }
    }
  }
  function hello(): void {
    send({ type: "hello", window: kind, buildId, focused: doc.hasFocus() });
  }
  win.__cxpReceive = (msg: any) => {
    if (msg?.type === "state") applyState(msg as DaemonState);
    else if (msg?.type === "response") settle(msg);
  };
  win.__cxpLoaderResync = () => {
    hello();
    for (const slot of slots.values()) {
      if (slot.status) send({ type: "status", plugin: slot.id, state: slot.status, reason: slot.reason });
    }
  };

  function request(plugin: string, method: string, params?: unknown): Promise<unknown> {
    const id = ++requestSeq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: "request", id, plugin, method, params });
    });
  }
  function settle(msg: { id: number; result?: unknown; error?: unknown }): void {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error != null) entry.reject(new Error(errorText(msg.error)));
    else entry.resolve(msg.result);
  }

  // ---- state ----
  function entry(id: string, state = daemon): DaemonPlugin | undefined {
    return state?.plugins.find((p) => p.id === id);
  }
  function applyState(next: DaemonState): void {
    const prev = daemon;
    daemon = next;
    for (const slot of slots.values()) {
      // A retry from another window clears the daemon's failed mark; follow it here too.
      if (slot.failed && entry(slot.id, prev)?.status === "failed" && entry(slot.id)?.status !== "failed") {
        slot.failed = false;
      }
    }
    reconcileAll();
    notify();
  }
  function patchEntry(id: string, patch: Partial<DaemonPlugin>): void {
    if (!daemon || !entry(id)) return;
    daemon = { ...daemon, plugins: daemon.plugins.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
  }
  function getState(): LoaderState {
    const local: LoaderState["local"] = {};
    for (const slot of slots.values()) {
      if (slot.status) local[slot.id] = { status: slot.status, reason: slot.reason };
    }
    return { window: kind, buildId, daemon, local };
  }
  function notify(): void {
    const state = getState();
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (error) {
        console.warn("[cxp] listener failed", error);
      }
    }
  }
  function setStatus(slot: Slot, status: PluginStatus, reason?: string, report = true): void {
    if (slot.status === status && slot.reason === reason) return;
    slot.status = status;
    slot.reason = reason;
    if (report) send({ type: "status", plugin: slot.id, state: status, reason });
    notify();
  }

  // ---- lifecycle ----
  function guardPresent(slot: Slot): boolean {
    return slot.forkGuards.some((name) => win[name] != null);
  }
  function reconcileAll(): void {
    for (const slot of slots.values()) reconcile(slot);
  }
  function reconcile(slot: Slot): void {
    if (!ready || !daemon) return;
    const p = entry(slot.id);
    if (!p) return stop(slot);
    if (!p.enabled) {
      slot.failed = false;
      stop(slot);
      return setStatus(slot, "off");
    }
    if (slot.failed) return;
    if (p.status === "failed" && p.source && NON_PAGE_SOURCES.has(p.source)) {
      stop(slot);
      return setStatus(slot, "failed", p.reason, false);
    }
    if (guardPresent(slot)) {
      stop(slot);
      return setStatus(slot, "dormant");
    }
    const key = JSON.stringify(p.settings ?? {});
    if (slot.running && slot.settingsKey !== key) stop(slot);
    if (slot.running) return setStatus(slot, "active");
    start(slot, p.settings ?? {}, key);
  }
  function start(slot: Slot, settings: Record<string, unknown>, key: string): void {
    const gen = ++slot.gen;
    let activating = true;
    let pendingFail: string | undefined;
    const api: PluginApi = {
      id: slot.id,
      window: kind,
      settings: { ...settings },
      request: (method, params) => request(slot.id, method, params),
      fail: (reason) => {
        if (slot.gen !== gen) return;
        if (activating) pendingFail ??= errorText(reason);
        else fail(slot, errorText(reason));
      },
      log: (...args) => console.log(`[cxp:${slot.id}]`, ...args),
    };
    slot.running = true;
    slot.settingsKey = key;
    slot.fastUntil = Date.now() + GUARD_FAST_WINDOW_MS;
    slot.nextGuardCheck = Date.now() + GUARD_FAST_MS;
    try {
      const cleanup = slot.activate(api);
      if (typeof cleanup === "function") slot.cleanup = cleanup;
    } catch (error) {
      activating = false;
      return fail(slot, errorText(error));
    }
    activating = false;
    if (pendingFail !== undefined) return fail(slot, pendingFail);
    if (kind === "main") clearFailureNotice(doc, slot.id);
    setStatus(slot, "active");
  }
  function stop(slot: Slot): void {
    if (!slot.running) return;
    slot.running = false;
    slot.gen++;
    slot.settingsKey = undefined;
    const cleanup = slot.cleanup;
    slot.cleanup = undefined;
    try {
      cleanup?.();
    } catch (error) {
      console.warn(`[cxp:${slot.id}] cleanup failed`, error);
    }
  }
  function fail(slot: Slot, reason: string): void {
    stop(slot);
    slot.failed = true;
    setStatus(slot, "failed", reason);
    if (kind === "main") showFailureNotice(doc, slot.id, entry(slot.id)?.name ?? slot.id, reason);
  }
  function guardTick(): void {
    const now = Date.now();
    for (const slot of slots.values()) {
      if (now < slot.nextGuardCheck) continue;
      slot.nextGuardCheck = now + (now < slot.fastUntil ? GUARD_FAST_MS : GUARD_SLOW_MS);
      if (slot.status === "active" || slot.status === "dormant") reconcile(slot);
    }
  }

  // ---- public surface ----
  win.__cxpLoaderRegister = (id: string, activate: Activate, meta?: { forkGuards?: string[] }) => {
    if (slots.has(id) || typeof activate !== "function") return;
    const slot: Slot = {
      id,
      activate,
      forkGuards: meta?.forkGuards ?? [],
      running: false,
      gen: 0,
      failed: false,
      fastUntil: 0,
      nextGuardCheck: 0,
    };
    slots.set(id, slot);
    reconcile(slot);
  };
  const api: LoaderV1 = {
    window: kind,
    getState,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setEnabled(id, on) {
      send({ type: "enable", plugin: id, enabled: on });
      const slot = slots.get(id);
      patchEntry(id, { enabled: on });
      if (slot) reconcile(slot);
      notify();
    },
    setSettings(id, values) {
      send({ type: "settings:set", plugin: id, values });
      patchEntry(id, { settings: { ...entry(id)?.settings, ...values } });
      const slot = slots.get(id);
      if (slot) reconcile(slot);
      notify();
    },
    retry(id) {
      send({ type: "retry", plugin: id });
      const slot = slots.get(id);
      if (!slot) return;
      slot.failed = false;
      reconcile(slot);
    },
  };
  win.__cxpLoaderV1 = api;

  win.addEventListener("focus", () => send({ type: "focus", focused: true }));
  win.addEventListener("blur", () => send({ type: "focus", focused: false }));
  hello();

  // Wait for the page and codexhost's Host routing; start anyway after the timeout so
  // plugins that need Host can report the problem themselves via api.fail.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const waitReady = () => {
    if ((doc.body && win.__codexhostHostRoutingV1) || Date.now() >= deadline) {
      ready = true;
      setInterval(guardTick, GUARD_FAST_MS);
      reconcileAll();
      return;
    }
    setTimeout(waitReady, READY_POLL_MS);
  };
  waitReady();
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return JSON.stringify(error) ?? String(error);
}
