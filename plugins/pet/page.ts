// Pet window plugin entry: mounts stack max height hook, avatar overlay, card agent resolution,
// Quick Chat remote target picker, and remote projectless session injection.

import type { PluginApi } from "../types.ts";
import {
  DEFAULT_PETS_STACK_MAX_HEIGHT_PX,
  clampPetsStackMaxHeight,
  installPetsStackHeightHook,
  installRendererAvatarOverlay,
  type PetsHarnessCatalog,
} from "./avatar-overlay/index.ts";
import { createPetsCardAgentResolver } from "./card-agents/index.ts";
import {
  fetchPetsRemoteProjectsFromHost,
  type DesktopRemoteProjectEntry,
  type PetsRemoteProject,
} from "./quick-chat-target/index.ts";
import {
  compatibleRendererPluginPresentation,
  type HarnessPluginDescriptor,
} from "./vendor/agent-icon.ts";

const REMOTE_SYNC_INTERVAL_MS = 30_000;

export interface PetActivateEnv {
  readonly document?: Document;
  readonly window?: Window;
  readonly syncIntervalMs?: number;
}

function readBoolSetting(
  settings: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = settings[key];
  return typeof value === "boolean" ? value : fallback;
}

function parseDesktopRemoteProjects(value: unknown): DesktopRemoteProjectEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: DesktopRemoteProjectEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.id === "string" &&
      raw.id &&
      typeof raw.hostId === "string" &&
      raw.hostId &&
      typeof raw.path === "string" &&
      raw.path
    ) {
      entries.push({
        id: raw.id,
        hostId: raw.hostId,
        name: typeof raw.name === "string" && raw.name ? raw.name : raw.path,
        path: raw.path,
      });
    }
  }
  return entries;
}

export default function activate(api: PluginApi, env: PetActivateEnv = {}): () => void {
  const win = env.window ?? (typeof window !== "undefined" ? window : undefined);
  const doc = env.document ?? (typeof document !== "undefined" ? document : undefined);
  if (!win || !doc) return () => {};

  const stackMaxHeight = clampPetsStackMaxHeight(
    api.settings.stackMaxHeight ?? DEFAULT_PETS_STACK_MAX_HEIGHT_PX,
  );
  const enableRemoteSessions = readBoolSetting(api.settings, "remoteSessions", true);
  const enableQuickChatTarget = readBoolSetting(api.settings, "quickChatTarget", true);
  const enableCardAgents = readBoolSetting(api.settings, "cardAgents", true);

  let disposed = false;
  let liveProjects: readonly PetsRemoteProject[] = [];
  let liveCatalog: PetsHarnessCatalog | null = null;
  let syncInflight = false;

  const disposeStackHook = installPetsStackHeightHook(win, () => stackMaxHeight);

  const cardAgentResolver = enableCardAgents
    ? createPetsCardAgentResolver({
        onResolved: () => {
          if (!disposed) overlay.refresh();
        },
      })
    : null;

  const overlay = installRendererAvatarOverlay({
    document: doc,
    window: win,
    enableRemoteSessions,
    enableQuickChatTarget,
    enableCardAgents,
    getRemoteProjects: () => liveProjects,
    getHarnessCatalog: () => liveCatalog,
    resolveCardAgents: cardAgentResolver
      ? (cardThreads, known) => cardAgentResolver.resolve(cardThreads, known)
      : undefined,
  });

  const syncFromHost = async (): Promise<void> => {
    if (disposed || syncInflight) return;
    syncInflight = true;
    try {
      const storage = (() => {
        try {
          return win.localStorage ?? null;
        } catch {
          return null;
        }
      })();
      const result = await fetchPetsRemoteProjectsFromHost({
        listDesktopRemoteProjects: async () =>
          parseDesktopRemoteProjects(await api.request("remoteProjects/list")),
        storage,
      });
      if (disposed) return;

      liveProjects = result.projects;

      const localPlugins = result.hostPlugins.get("local") ?? [];
      const localById = new Map(localPlugins.map((p) => [p.id, p]));
      const mergedPlugins = new Map<string, HarnessPluginDescriptor>();
      for (const [hostId, list] of result.hostPlugins) {
        for (const p of list) {
          const normalized =
            compatibleRendererPluginPresentation(p, localById.get(p.id)) ?? p;
          if (!mergedPlugins.has(p.id) || hostId === "local") {
            mergedPlugins.set(p.id, normalized);
          }
        }
      }
      if (mergedPlugins.size > 0) {
        liveCatalog = {
          enabledAgents: ["codex", ...mergedPlugins.keys()],
          plugins: [...mergedPlugins.values()].map((p) => ({
            id: p.id,
            name: p.name ?? p.id,
            ...(p.icon ? { icon: p.icon } : {}),
            ...(p.iconStyle ? { iconStyle: p.iconStyle } : {}),
          })),
        };
      }
      overlay.refresh();
    } catch {
      // Host routing or daemon request may not be ready yet; keep fallback and retry on next tick.
    } finally {
      syncInflight = false;
    }
  };

  void syncFromHost();
  const intervalMs = env.syncIntervalMs ?? REMOTE_SYNC_INTERVAL_MS;
  const syncTimer = intervalMs > 0 ? win.setInterval(() => void syncFromHost(), intervalMs) : null;
  const onFocus = (): void => {
    void syncFromHost();
  };
  win.addEventListener("focus", onFocus);

  return () => {
    if (disposed) return;
    disposed = true;
    if (syncTimer !== null) win.clearInterval(syncTimer);
    win.removeEventListener("focus", onFocus);
    cardAgentResolver?.dispose();
    overlay.dispose();
    disposeStackHook();
  };
}
