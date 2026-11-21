// Copyright (C) CodexHost contributors.
// SPDX-License-Identifier: LGPL-3.0-only
// Ported from codex-host packages/renderer-extension/src/renderer-pets-card-agents.ts.

import { hostRequest, hostRouting } from "../../../shared/host.ts";

export const PETS_CARD_THREADS_STORAGE_KEY = "codexhost.pets-card-threads.v1";
export const THREAD_OWNERSHIP_LIST_METHOD = "codexhost/thread/ownership/list";
const THREAD_OWNERSHIP_LIST_MAX_LENGTH = 100;
/** A Codex answer may come before Host records an external thread, so it is asked again later. */
const CODEX_OWNERSHIP_TTL_MS = 30_000;

type ReadableStorage = Pick<Storage, "getItem"> | null | undefined;
type WritableStorage = Pick<Storage, "getItem" | "setItem"> | null | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function writePetsCardThreads(keys: readonly string[], storage: WritableStorage): void {
  try {
    const next = JSON.stringify([...new Set(keys)].sort());
    if (storage?.getItem(PETS_CARD_THREADS_STORAGE_KEY) !== next)
      storage?.setItem(PETS_CARD_THREADS_STORAGE_KEY, next);
  } catch {
    // Ignore storage errors.
  }
}

export function readPetsCardThreads(storage: ReadableStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(PETS_CARD_THREADS_STORAGE_KEY) ?? "");
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

const splitKey = (key: string): { hostId: string; threadId: string } | null => {
  const separator = key.lastIndexOf(":");
  return separator > 0 && separator < key.length - 1
    ? { hostId: key.slice(0, separator), threadId: key.slice(separator + 1) }
    : null;
};

export interface ThreadOwnershipItem {
  readonly threadId: string;
  readonly owner: string;
}

export interface PetsCardAgentResolver {
  /**
   * Resolves external Agents for the Pet's card threads via Host's `codexhost/thread/ownership/list`.
   * Unknown threads are queried in the background; `onResolved` fires when an answer arrives.
   */
  resolve(
    cardThreads: readonly string[],
    known?: Readonly<Record<string, string>>,
  ): Record<string, string>;
  dispose(): void;
}

function parseOwnershipList(value: unknown): ThreadOwnershipItem[] {
  if (!isRecord(value) || !Array.isArray(value.threads)) return [];
  const items: ThreadOwnershipItem[] = [];
  for (const item of value.threads) {
    if (
      !isRecord(item) ||
      typeof item.threadId !== "string" ||
      !item.threadId ||
      typeof item.owner !== "string" ||
      !item.owner
    ) {
      continue;
    }
    items.push({ threadId: item.threadId, owner: item.owner });
  }
  return items;
}

export function createPetsCardAgentResolver(options: {
  readonly onResolved: () => void;
  readonly requestOwnership?: (
    hostId: string,
    threadIds: readonly string[],
  ) => Promise<readonly ThreadOwnershipItem[]>;
  readonly now?: () => number;
}): PetsCardAgentResolver {
  const now = options.now ?? Date.now;
  const owners = new Map<string, { agent: string; at: number }>();
  const pending = new Set<string>();
  let disposed = false;

  const defaultRequestOwnership = async (
    hostId: string,
    threadIds: readonly string[],
  ): Promise<readonly ThreadOwnershipItem[]> => {
    if (!hostRouting()) return [];
    const result = await hostRequest(hostId, THREAD_OWNERSHIP_LIST_METHOD, { threadIds });
    return parseOwnershipList(result);
  };

  const requestOwnership = options.requestOwnership ?? defaultRequestOwnership;

  const request = (hostId: string, keys: string[]): void => {
    const threadIds = keys
      .map((key) => splitKey(key)?.threadId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (threadIds.length === 0) return;
    for (const key of keys) pending.add(key);
    void Promise.resolve()
      .then(() => requestOwnership(hostId, threadIds))
      .then((threads) => {
        if (disposed) return;
        let changed = false;
        for (const ownership of threads) {
          const key = `${hostId}:${ownership.threadId}`;
          const prev = owners.get(key);
          owners.set(key, { agent: ownership.owner, at: now() });
          if (prev?.agent !== ownership.owner) changed = true;
        }
        if (changed) options.onResolved();
      })
      .catch(() => {
        // Host may be disconnected or method unavailable; keep fallback.
      })
      .finally(() => {
        for (const key of keys) pending.delete(key);
      });
  };

  return {
    resolve(cardThreads, known = {}) {
      const agents: Record<string, string> = {};
      if (disposed) return agents;
      const missingByHost = new Map<string, string[]>();
      for (const key of cardThreads) {
        if (known[key]) continue;
        const owner = owners.get(key);
        if (owner && owner.agent !== "codex") {
          agents[key] = owner.agent;
          continue;
        }
        if (pending.has(key) || (owner && now() - owner.at < CODEX_OWNERSHIP_TTL_MS)) continue;
        const parsed = splitKey(key);
        if (!parsed || !parsed.threadId.trim()) continue;
        const keys = missingByHost.get(parsed.hostId) ?? [];
        if (keys.length < THREAD_OWNERSHIP_LIST_MAX_LENGTH) keys.push(key);
        missingByHost.set(parsed.hostId, keys);
      }
      for (const [hostId, keys] of missingByHost) request(hostId, keys);
      return agents;
    },
    dispose() {
      disposed = true;
      pending.clear();
    },
  };
}
