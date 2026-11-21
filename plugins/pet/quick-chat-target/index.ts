// Copyright (C) CodexHost contributors.
// SPDX-License-Identifier: LGPL-3.0-only
// Ported from codex-host packages/renderer-extension/src/renderer-pets-quick-chat-target.ts.

import { hostRequest, hostRouting } from "../../../shared/host.ts";
import {
  resolveShortHostLabel,
  type SidebarRemoteProject,
} from "../../../shared/remote-projects.ts";
import { CXP_QUICK_CHAT_TARGET_HOOK } from "../rewrites.ts";
import type { HarnessPluginDescriptor } from "../vendor/agent-icon.ts";

/** Remote projects Pet Quick Chat can start a thread in. */
export const PETS_REMOTE_PROJECTS_STORAGE_KEY = "codexhost.pets-remote-projects.v1";
/** The Pet's Quick Chat location: absent for this machine, else `hostId\nprojectId`. */
export const PETS_QUICK_CHAT_TARGET_STORAGE_KEY = "codexhost.pets-quick-chat-target.v1";

export const CONSOLE_REMOTE_CONNECTIONS_METHOD = "codexhost/console/remote-connections";
export const WORKSPACE_READ_METHOD = "codexhost/workspace/read";
export const HARNESS_PLUGIN_LIST_METHOD = "codexhost/harness/plugins/list";

export interface PetsRemoteProject extends Omit<SidebarRemoteProject, "hostDisplayName"> {
  readonly hostLabel: string;
  readonly hostColor: string | null;
  /** Agents installed on the project's host, Codex first. */
  readonly agents: readonly string[];
}

/** The thread-creation target Codex's Quick Chat accepts for a remote project. */
export interface QuickChatRemoteProjectTarget {
  readonly type: "remoteProject";
  readonly hostId: string;
  readonly projectId: string;
  readonly path: string;
  /** Quick Chat runs in the project directory itself, never in a new worktree. */
  readonly environment: { readonly type: "local" };
  readonly clientThreadId: string;
}

export interface DesktopRemoteProjectEntry {
  readonly id: string;
  readonly hostId: string;
  readonly name: string;
  readonly path: string;
}

type ReadableStorage = Pick<Storage, "getItem"> | null | undefined;
type WritableStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;

const targetKey = (project: Pick<PetsRemoteProject, "hostId" | "projectId">): string =>
  `${project.hostId}\n${project.projectId}`;

const isString = (value: unknown): value is string => typeof value === "string";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isRemoteHostId = (hostId: string): boolean => /^remote[-:]/u.test(hostId);

export function writePetsRemoteProjects(
  projects: readonly PetsRemoteProject[],
  storage: WritableStorage,
): void {
  try {
    const next = JSON.stringify(projects);
    if (storage?.getItem(PETS_REMOTE_PROJECTS_STORAGE_KEY) !== next)
      storage?.setItem(PETS_REMOTE_PROJECTS_STORAGE_KEY, next);
  } catch {
    // Ignore storage errors.
  }
}

export function readPetsRemoteProjects(storage: ReadableStorage): PetsRemoteProject[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(PETS_REMOTE_PROJECTS_STORAGE_KEY) ?? "");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((raw: unknown): PetsRemoteProject[] => {
      if (!isRecord(raw)) return [];
      if (![raw.hostId, raw.projectId, raw.path, raw.label, raw.hostLabel].every(isString))
        return [];
      return [
        {
          hostId: raw.hostId as string,
          projectId: raw.projectId as string,
          path: raw.path as string,
          label: raw.label as string,
          hostLabel: raw.hostLabel as string,
          hostColor: isString(raw.hostColor) ? raw.hostColor : null,
          agents: Array.isArray(raw.agents) ? raw.agents.filter(isString) : ["codex"],
        },
      ];
    });
  } catch {
    return [];
  }
}

/** The selected remote project, or `null` for this machine (also when it is no longer listed). */
export function readPetsQuickChatTarget(
  storage: ReadableStorage,
  projects: readonly PetsRemoteProject[],
): PetsRemoteProject | null {
  try {
    const stored = storage?.getItem(PETS_QUICK_CHAT_TARGET_STORAGE_KEY);
    return stored ? (projects.find((p) => targetKey(p) === stored) ?? null) : null;
  } catch {
    return null;
  }
}

export function writePetsQuickChatTarget(
  project: Pick<PetsRemoteProject, "hostId" | "projectId"> | null,
  storage: WritableStorage,
): void {
  try {
    if (project) storage?.setItem(PETS_QUICK_CHAT_TARGET_STORAGE_KEY, targetKey(project));
    else storage?.removeItem(PETS_QUICK_CHAT_TARGET_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

/**
 * Serves the Quick Chat target to the rewritten Codex Pet chunk (see `plugins/pet/rewrites.ts`).
 * Returning `undefined` keeps Codex's own target: this machine, no project.
 */
export function installPetsQuickChatTargetHook(
  win: Window,
  selected: () => PetsRemoteProject | null,
): () => void {
  const state = win as unknown as Record<string, unknown>;
  const hook = (clientThreadId: string): QuickChatRemoteProjectTarget | undefined => {
    const project = selected();
    return project
      ? {
          type: "remoteProject",
          hostId: project.hostId,
          projectId: project.projectId,
          path: project.path,
          environment: { type: "local" },
          clientThreadId,
        }
      : undefined;
  };
  state[CXP_QUICK_CHAT_TARGET_HOOK] = hook;
  return () => {
    if (state[CXP_QUICK_CHAT_TARGET_HOOK] === hook)
      Reflect.deleteProperty(state, CXP_QUICK_CHAT_TARGET_HOOK);
  };
}

export function parseHostPluginDescriptors(value: unknown): HarnessPluginDescriptor[] {
  if (!isRecord(value) || !Array.isArray(value.plugins)) return [];
  const plugins: HarnessPluginDescriptor[] = [];
  for (const item of value.plugins) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
    plugins.push({
      id: item.id,
      ...(typeof item.name === "string" && item.name ? { name: item.name } : {}),
      ...(typeof item.icon === "string" && item.icon ? { icon: item.icon } : {}),
      ...(isRecord(item.iconStyle)
        ? { iconStyle: item.iconStyle as HarnessPluginDescriptor["iconStyle"] }
        : {}),
    });
  }
  return plugins;
}

export interface FetchRemoteProjectsResult {
  readonly projects: readonly PetsRemoteProject[];
  readonly hostPlugins: ReadonlyMap<string, readonly HarnessPluginDescriptor[]>;
}

/**
 * Fetches Pet Quick Chat's remote project list directly from public Host RPCs via `shared/host.ts`:
 * - `codexhost/console/remote-connections` (`{ action: "list" }`) on `"local"` for remote hosts & display names
 * - `codexhost/workspace/read` on each remote host for projects persisted on that host
 * - `codexhost/harness/plugins/list` on `"local"` and each remote host for available Agents & icons
 *
 * Optionally merges Desktop's registered remote projects (read by the daemon task from
 * `.codex-global-state.json` `"remote-projects"`) and any stored `localStorage` fallback.
 */
export async function fetchPetsRemoteProjectsFromHost(options: {
  readonly requestHost?: (host: string, method: string, params?: unknown) => Promise<unknown>;
  readonly getKnownHostIds?: () => readonly string[];
  readonly listDesktopRemoteProjects?: () => Promise<readonly DesktopRemoteProjectEntry[]>;
  readonly storage?: ReadableStorage;
} = {}): Promise<FetchRemoteProjectsResult> {
  const routing = hostRouting();
  const requestHost =
    options.requestHost ?? (routing ? hostRequest : null);
  const knownHostIds =
    options.getKnownHostIds ??
    (() => {
      const fn = (routing as { knownHostIds?: () => unknown } | null)?.knownHostIds;
      const list = typeof fn === "function" ? fn.call(routing) : [];
      return Array.isArray(list) ? list.filter(isString) : [];
    });

  const hostDisplayNames = new Map<string, string>();
  const remoteHostIds = new Set<string>();
  const hostPlugins = new Map<string, readonly HarnessPluginDescriptor[]>();

  for (const id of knownHostIds()) {
    if (isRemoteHostId(id)) remoteHostIds.add(id);
  }

  // 1. Discover configured remote SSH connections from local Host.
  if (requestHost) {
    try {
      const connections = await requestHost("local", CONSOLE_REMOTE_CONNECTIONS_METHOD, {
        action: "list",
      });
      if (Array.isArray(connections)) {
        for (const conn of connections) {
          if (!isRecord(conn) || typeof conn.hostId !== "string" || !conn.hostId.trim()) continue;
          const id = conn.hostId.trim();
          if (isRemoteHostId(id)) remoteHostIds.add(id);
          const rawLabel =
            (isString(conn.displayName) && conn.displayName.trim()) ||
            (isString(conn.sshAlias) && conn.sshAlias.trim()) ||
            (isString(conn.sshHost) && conn.sshHost.trim()) ||
            id;
          hostDisplayNames.set(id, rawLabel);
        }
      }
    } catch {
      // Host may not expose console remote-connections in all environments.
    }
  }

  // 2. Optionally read Desktop's registered remote-projects metadata via daemon task.
  const desktopProjects: DesktopRemoteProjectEntry[] = [];
  if (options.listDesktopRemoteProjects) {
    try {
      const items = await options.listDesktopRemoteProjects();
      for (const item of items) {
        if (!item.id || !item.hostId || !item.path) continue;
        desktopProjects.push(item);
        if (isRemoteHostId(item.hostId)) remoteHostIds.add(item.hostId);
      }
    } catch {
      // Daemon task unavailable (e.g. unit test without daemon).
    }
  }

  // 3. Query local + remote hosts for Harness plugins and remote workspaces.
  const hostWorkspaceProjects: DesktopRemoteProjectEntry[] = [];
  if (requestHost) {
    const pluginHosts = ["local", ...remoteHostIds];
    await Promise.all(
      pluginHosts.map(async (hostId) => {
        try {
          const result = await requestHost(hostId, HARNESS_PLUGIN_LIST_METHOD, {});
          hostPlugins.set(hostId, parseHostPluginDescriptors(result));
        } catch {
          // Ignore disconnected or older hosts.
        }
      }),
    );

    await Promise.all(
      [...remoteHostIds].map(async (hostId) => {
        try {
          const snapshot = await requestHost(hostId, WORKSPACE_READ_METHOD, {});
          if (!isRecord(snapshot) || !Array.isArray(snapshot.projects)) return;
          for (const project of snapshot.projects) {
            if (!isRecord(project) || typeof project.id !== "string" || !project.id) continue;
            const roots = Array.isArray(project.rootPaths)
              ? project.rootPaths.filter((p): p is string => typeof p === "string" && p.length > 0)
              : [];
            const rootPath = roots[0];
            if (!rootPath) continue;
            const name =
              typeof project.name === "string" && project.name.trim() ? project.name : rootPath;
            hostWorkspaceProjects.push({ id: project.id, hostId, name, path: rootPath });
          }
        } catch {
          // Remote host may be offline or not expose workspace/read.
        }
      }),
    );
  }

  // 4. Merge stored projects (for colors / fallback) with Desktop & Host-fetched projects.
  const storedProjects = readPetsRemoteProjects(options.storage);
  const storedByKey = new Map(storedProjects.map((p) => [targetKey(p), p]));
  const colorByHost = new Map<string, string>();
  for (const p of storedProjects) {
    if (p.hostColor && !colorByHost.has(p.hostId)) colorByHost.set(p.hostId, p.hostColor);
  }

  const merged = new Map<string, PetsRemoteProject>();
  const addEntry = (entry: DesktopRemoteProjectEntry) => {
    const key = `${entry.hostId}\n${entry.id}`;
    if (merged.has(key)) return;
    const stored = storedByKey.get(key);
    const plugins = hostPlugins.get(entry.hostId);
    const agents = plugins
      ? ["codex", ...plugins.map((p) => p.id).filter((id) => id !== "codex")]
      : (stored?.agents ?? ["codex"]);
    const hostLabel =
      resolveShortHostLabel(entry.hostId, hostDisplayNames.get(entry.hostId)) ??
      stored?.hostLabel ??
      entry.hostId;
    merged.set(key, {
      hostId: entry.hostId,
      projectId: entry.id,
      label: entry.name || entry.path,
      path: entry.path,
      hostLabel,
      hostColor: stored?.hostColor ?? colorByHost.get(entry.hostId) ?? null,
      agents,
    });
  };

  // Prefer Desktop's explicit remote-projects order first, then remote Host workspace projects.
  for (const entry of desktopProjects) addEntry(entry);
  for (const entry of hostWorkspaceProjects) addEntry(entry);

  // If neither Host RPC nor Desktop metadata returned anything, fall back to localStorage.
  if (merged.size === 0) {
    for (const stored of storedProjects) merged.set(targetKey(stored), stored);
  }

  return { projects: [...merged.values()], hostPlugins };
}
