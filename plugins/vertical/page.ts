import type { PluginApi } from "../types.ts";
import { hostRequest, hostRouting } from "../../shared/host.ts";
import {
  collectSidebarRemoteProjects,
  resolveShortHostLabel,
} from "../../shared/remote-projects.ts";
import {
  DEFAULT_SIDEBAR_AUTO_COLLAPSE,
  DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT,
  clampSidebarOverlayBreakpoint,
  installRendererSidebarOverlay,
} from "./sidebar-overlay/index.ts";
import {
  DEFAULT_TOP_TABS_ENABLED,
  DEFAULT_TOP_TABS_TWO_ROWS,
  createWindowCxpStashBridge,
  installRendererTopTabs,
} from "./top-tabs/index.ts";
import {
  compatibleRendererPluginPresentation,
  type HarnessPluginDescriptor,
} from "./vendor/agent-icon.ts";

const THREAD_OWNERSHIP_LIST_METHOD = "codexhost/thread/ownership/list";
const HARNESS_PLUGIN_LIST_METHOD = "codexhost/harness/plugins/list";
const OWNERSHIP_BATCH_LIMIT = 100;

interface ActivateEnv {
  readonly document?: Document;
  readonly window?: Window;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolSetting(settings: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = settings[key];
  return typeof value === "boolean" ? value : fallback;
}

function detectLocale(doc: Document): string {
  return (
    doc.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "en")
  );
}

function parsePluginDescriptors(value: unknown): Map<string, HarnessPluginDescriptor> {
  const map = new Map<string, HarnessPluginDescriptor>();
  if (!isRecord(value) || !Array.isArray(value.plugins)) return map;
  for (const item of value.plugins) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
    const descriptor: HarnessPluginDescriptor = {
      id: item.id,
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(typeof item.icon === "string" ? { icon: item.icon } : {}),
      ...(isRecord(item.iconStyle)
        ? { iconStyle: item.iconStyle as HarnessPluginDescriptor["iconStyle"] }
        : {}),
    };
    map.set(descriptor.id, descriptor);
  }
  return map;
}

export default function activate(api: PluginApi, env: ActivateEnv = {}): () => void {
  const win = env.window ?? (typeof window !== "undefined" ? window : undefined);
  const doc = env.document ?? (typeof document !== "undefined" ? document : undefined);
  if (!win || !doc) return () => {};

  const sidebarAutoCollapse = readBoolSetting(
    api.settings,
    "sidebarAutoCollapse",
    DEFAULT_SIDEBAR_AUTO_COLLAPSE,
  );
  const sidebarOverlayBreakpoint = clampSidebarOverlayBreakpoint(
    api.settings.sidebarOverlayBreakpoint ?? DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT,
  );
  const topTabsEnabled = readBoolSetting(api.settings, "topTabsEnabled", DEFAULT_TOP_TABS_ENABLED);
  const topTabsTwoRows = readBoolSetting(api.settings, "topTabsTwoRows", DEFAULT_TOP_TABS_TWO_ROWS);

  let disposed = false;
  let ownershipTimer: number | null = null;
  const threadOwners = new Map<string, string>();
  const inflightOwnership = new Set<string>();
  const queuedOwnership = new Map<string, Set<string>>();
  const pluginsByHost = new Map<string, Map<string, HarnessPluginDescriptor>>();
  const inflightPlugins = new Set<string>();
  const acknowledgedFailedKeys = new Set<string>();

  const loadHostPlugins = (hostId: string): void => {
    if (disposed || !hostId || hostId === "durable") return;
    if (pluginsByHost.has(hostId) || inflightPlugins.has(hostId)) return;
    if (!hostRouting()) return;
    inflightPlugins.add(hostId);
    void hostRequest(hostId, HARNESS_PLUGIN_LIST_METHOD, {})
      .then((result) => {
        if (disposed) return;
        const parsed = parsePluginDescriptors(result);
        pluginsByHost.set(hostId, parsed);
        if (parsed.size > 0) topTabs.refresh();
      })
      .catch(() => {
        // Older or stock Hosts may not expose harness plugins; keep graceful fallback.
      })
      .finally(() => {
        inflightPlugins.delete(hostId);
      });
  };

  const flushOwnershipQueue = (): void => {
    ownershipTimer = null;
    if (disposed || !hostRouting()) {
      queuedOwnership.clear();
      return;
    }
    const batches = [...queuedOwnership.entries()];
    queuedOwnership.clear();
    for (const [hostId, idSet] of batches) {
      const ids = [...idSet];
      for (let offset = 0; offset < ids.length; offset += OWNERSHIP_BATCH_LIMIT) {
        const chunk = ids.slice(offset, offset + OWNERSHIP_BATCH_LIMIT);
        for (const threadId of chunk) inflightOwnership.add(`${hostId}:${threadId}`);
        void hostRequest(hostId, THREAD_OWNERSHIP_LIST_METHOD, { threadIds: chunk })
          .then((result) => {
            if (disposed || !isRecord(result) || !Array.isArray(result.threads)) return;
            let changed = false;
            for (const item of result.threads) {
              if (
                !isRecord(item) ||
                typeof item.threadId !== "string" ||
                typeof item.owner !== "string"
              ) {
                continue;
              }
              const key = `${hostId}:${item.threadId}`;
              if (threadOwners.get(key) !== item.owner) {
                threadOwners.set(key, item.owner);
                changed = true;
              }
              if (item.owner !== "codex") {
                loadHostPlugins(hostId);
                if (hostId !== "local") loadHostPlugins("local");
              }
            }
            if (changed) topTabs.refresh();
          })
          .catch(() => {
            // Host may be disconnected or method unavailable; ignore and keep sidebar fallback.
          })
          .finally(() => {
            for (const threadId of chunk) inflightOwnership.delete(`${hostId}:${threadId}`);
          });
      }
    }
  };

  const queueOwnershipLookup = (hostId: string, threadId: string): void => {
    if (disposed || !hostId || hostId === "durable" || !hostRouting()) return;
    const key = `${hostId}:${threadId}`;
    if (threadOwners.has(key) || inflightOwnership.has(key)) return;
    let bucket = queuedOwnership.get(hostId);
    if (!bucket) {
      bucket = new Set<string>();
      queuedOwnership.set(hostId, bucket);
    }
    bucket.add(threadId);
    if (ownershipTimer === null) {
      ownershipTimer = win.setTimeout(flushOwnershipQueue, 0);
    }
  };

  const resolveThreadAgent = (
    hostId: string,
    threadId: string,
    fallbackAgent?: string,
  ): { agent: string; plugin?: HarnessPluginDescriptor } | null => {
    const key = `${hostId}:${threadId}`;
    const owner = threadOwners.get(key);
    if (!owner) queueOwnershipLookup(hostId, threadId);
    const agent = owner ?? fallbackAgent ?? "codex";
    if (agent !== "codex") {
      loadHostPlugins(hostId);
      if (hostId !== "local") loadHostPlugins("local");
    }
    const plugin = compatibleRendererPluginPresentation(
      pluginsByHost.get(hostId)?.get(agent),
      pluginsByHost.get("local")?.get(agent),
    );
    return { agent, ...(plugin ? { plugin } : {}) };
  };

  const resolveHostLabel = (hostId: string): string | null => {
    if (!hostId || hostId === "local") return null;
    const project = collectSidebarRemoteProjects(doc).find((item) => item.hostId === hostId);
    return resolveShortHostLabel(hostId, project?.hostDisplayName ?? null);
  };

  const sidebarOverlay = installRendererSidebarOverlay({
    document: doc,
    window: win,
    getLocale: () => detectLocale(doc),
    autoCollapse: sidebarAutoCollapse,
    breakpoint: sidebarOverlayBreakpoint,
  });

  const topTabs = installRendererTopTabs({
    document: doc,
    window: win,
    getLocale: () => detectLocale(doc),
    getThreadAgent: resolveThreadAgent,
    getHostLabel: resolveHostLabel,
    acknowledgedFailedKeys,
    stash: createWindowCxpStashBridge(win),
    enabled: topTabsEnabled,
    twoRows: topTabsTwoRows,
  });

  return () => {
    if (disposed) return;
    disposed = true;
    if (ownershipTimer !== null) {
      win.clearTimeout(ownershipTimer);
      ownershipTimer = null;
    }
    queuedOwnership.clear();
    sidebarOverlay.dispose();
    topTabs.dispose();
  };
}
