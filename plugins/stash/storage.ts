import { emptyState, parseState, type StashState } from "./state.ts";

export const STORAGE_KEY = "codexhost.sidebar-stash.v1";
export const LEGACY_STORAGE_KEY = "codex-stash:v1";

export interface StashStorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function loadState(storage: StashStorageBackend | null | undefined = defaultStorage()): {
  state: StashState;
  dropped: number;
  migratedFromLegacy: boolean;
} {
  if (!storage) return { state: emptyState(), dropped: 0, migratedFromLegacy: false };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      const { state, dropped } = parseState(parsed);
      return { state, dropped, migratedFromLegacy: false };
    }
    const legacy = storage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as unknown;
      const { state, dropped } = parseState(parsed);
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* ignore quota */
      }
      return { state, dropped, migratedFromLegacy: true };
    }
    return { state: emptyState(), dropped: 0, migratedFromLegacy: false };
  } catch {
    return { state: emptyState(), dropped: 0, migratedFromLegacy: false };
  }
}

export function saveState(
  storage: StashStorageBackend | null | undefined,
  state: StashState,
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota / private mode */
  }
}

export function createPersistedStore<
  TStore extends {
    getState(): StashState;
    replace(next: StashState): void;
    subscribe(listener: (state: StashState) => void): () => void;
  },
>(
  StoreCtor: new (
    initial: StashState | null | undefined,
    options?: { clock?: () => Date },
  ) => TStore,
  options: {
    storage?: StashStorageBackend | null;
    clock?: () => Date;
  } = {},
): {
  store: TStore;
  migratedFromLegacy: boolean;
} {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const loaded = loadState(storage);
  const store = options.clock
    ? new StoreCtor(loaded.state, { clock: options.clock })
    : new StoreCtor(loaded.state);
  store.subscribe((next) => saveState(storage, next));
  return { store, migratedFromLegacy: loaded.migratedFromLegacy };
}

export function defaultStorage(): StashStorageBackend | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}
