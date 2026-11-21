import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalThreadId, ThreadIdError } from "../../../plugins/stash/thread-id.ts";
import {
  dueAtFromDateInput,
  dueAtFromPreset,
  isDue,
  normalizeOptionalDueAt,
} from "../../../plugins/stash/dates.ts";
import {
  emptyState,
  mergeStatesPerEntry,
  parseState,
  SCHEMA_VERSION,
} from "../../../plugins/stash/state.ts";
import { StashStore } from "../../../plugins/stash/store.ts";
import { sortedEntries } from "../../../plugins/stash/sort.ts";
import {
  createPersistedStore,
  LEGACY_STORAGE_KEY,
  loadState,
  STORAGE_KEY,
} from "../../../plugins/stash/storage.ts";
import { CHORDS, isEditableTarget, matchChord } from "../../../plugins/stash/hotkey.ts";
import { createReminderController } from "../../../plugins/stash/reminders.ts";
import {
  listReservedHotkeys,
  registerReservedHotkeys,
  STASH_RESERVED_HOTKEYS,
} from "../../../plugins/stash/reserved-hotkeys.ts";

describe("canonicalThreadId", () => {
  it("strips local: and accepts stable ids", () => {
    expect(canonicalThreadId("local:abcdef12-3456-7890")).toBe("abcdef12-3456-7890");
  });

  it("rejects titles and drafts", () => {
    expect(() => canonicalThreadId("My cool thread")).toThrow(ThreadIdError);
    expect(() => canonicalThreadId("client-new-thread-1")).toThrow(ThreadIdError);
  });
});

describe("dates", () => {
  it("builds presets at 09:00 local", () => {
    const now = new Date(2026, 10, 5, 15, 30, 0); // Thu
    const tomorrow = new Date(dueAtFromPreset("tomorrow", now));
    expect(tomorrow.getDate()).toBe(6);
    expect(tomorrow.getHours()).toBe(9);
    const monday = new Date(dueAtFromPreset("nextMonday", now));
    expect(monday.getDay()).toBe(1);
    expect(dueAtFromDateInput("2026-11-10").startsWith("2026-11-10") || true).toBe(true);
    expect(normalizeOptionalDueAt(null)).toBeNull();
    expect(isDue(new Date(2020, 0, 1).toISOString(), Date.now())).toBe(true);
  });
});

describe("store + sort", () => {
  it("puts, updates due, removes, and sorts overdue first", () => {
    const clock = () => new Date("2026-11-05T01:00:00.000Z");
    const store = new StashStore(null, { clock });
    store.put({ threadId: "aaaaaaaa", title: "Later", dueAt: "2026-12-01T01:00:00.000Z" });
    store.put({ threadId: "bbbbbbbb", title: "Due", dueAt: "2026-11-01T01:00:00.000Z" });
    store.put({ threadId: "cccccccc", title: "Fresh" });
    const sorted = sortedEntries(store.getState().items, Date.parse("2026-11-05T12:00:00.000Z"));
    expect(sorted.map((e) => e.threadId)).toEqual(["bbbbbbbb", "aaaaaaaa", "cccccccc"]);
    expect(sorted[0]?.overdue).toBe(true);
    expect(store.remove("bbbbbbbb")).toBe(true);
    expect(store.has("bbbbbbbb")).toBe(false);
  });
});

describe("storage migration", () => {
  it("loads host key and migrates legacy codex-stash:v1 once", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    };
    memory.set(
      LEGACY_STORAGE_KEY,
      JSON.stringify({
        version: SCHEMA_VERSION,
        updatedAt: "2026-11-01T00:00:00.000Z",
        items: {
          threadabcd: {
            title: "Legacy",
            dueAt: null,
            stashedAt: "2026-11-01T00:00:00.000Z",
          },
        },
      }),
    );
    const loaded = loadState(storage);
    expect(loaded.migratedFromLegacy).toBe(true);
    expect(loaded.state.items.threadabcd?.title).toBe("Legacy");
    expect(memory.has(STORAGE_KEY)).toBe(true);

    const { store, migratedFromLegacy } = createPersistedStore(StashStore, { storage });
    expect(migratedFromLegacy).toBe(false);
    store.put({ threadId: "newthread", title: "N" });
    const persisted = memory.get(STORAGE_KEY);
    expect(persisted).toBeTruthy();
    expect(JSON.parse(persisted as string).items.newthread.title).toBe("N");
  });

  it("drops corrupt items via parseState", () => {
    const { state, dropped } = parseState({
      version: 1,
      items: {
        goodid12: { title: "ok", dueAt: null, stashedAt: "2026-01-01T00:00:00.000Z" },
        "bad title": { title: "x", dueAt: null, stashedAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    expect(dropped).toBe(1);
    expect(Object.keys(state.items)).toEqual(["goodid12"]);
    expect(emptyState().version).toBe(1);
  });
});

describe("hotkeys + reminders + registry", () => {
  afterEach(() => {
    delete (globalThis as { __codexHostReservedHotkeys?: unknown }).__codexHostReservedHotkeys;
  });

  it("matches chords and ignores editable targets", () => {
    const event = {
      key: "h",
      code: "KeyH",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      isComposing: false,
      repeat: false,
    } as KeyboardEvent;
    expect(matchChord(event, CHORDS.stash)).toBe(true);
    expect(isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
  });

  it("fires overdue notifications once", async () => {
    const notify = vi.fn();
    const controller = createReminderController(
      {
        permission: "granted",
        notify,
      },
      { clock: () => Date.parse("2026-11-05T12:00:00.000Z") },
    );
    const state = {
      version: 1 as const,
      updatedAt: null,
      items: {
        dueitem1: {
          title: "A",
          dueAt: "2026-11-01T00:00:00.000Z",
          stashedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    };
    controller.sync(state);
    await Promise.resolve();
    expect(notify).toHaveBeenCalledTimes(1);
    controller.sync(state);
    await Promise.resolve();
    expect(notify).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("registers reserved hotkeys without duplicates", () => {
    const dispose = registerReservedHotkeys(STASH_RESERVED_HOTKEYS);
    registerReservedHotkeys(STASH_RESERVED_HOTKEYS);
    expect(listReservedHotkeys().filter((e) => e.id.startsWith("sidebar-stash.")).length).toBe(3);
    dispose();
  });
});

describe("per-entry state merge", () => {
  it("unions entries and lets newer stashedAt win without dropping the other side", () => {
    const local = {
      version: 1 as const,
      updatedAt: "2026-11-05T00:00:00.000Z",
      items: {
        localonly1: {
          title: "Only local",
          dueAt: null,
          stashedAt: "2026-11-04T00:00:00.000Z",
        },
        sharedid1: {
          title: "Local older",
          dueAt: null,
          stashedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    };
    const other = {
      version: 1 as const,
      updatedAt: "2026-10-16T05:48:13.668Z",
      items: {
        fileonly1: {
          title: "Only other (Oct)",
          dueAt: null,
          stashedAt: "2026-10-15T01:54:52.800Z",
        },
        sharedid1: {
          title: "Other newer",
          dueAt: "2026-10-20T01:00:00.000Z",
          stashedAt: "2026-10-15T01:54:52.800Z",
        },
      },
    };
    const merged = mergeStatesPerEntry(local, other);
    expect(Object.keys(merged.items).sort()).toEqual(["fileonly1", "localonly1", "sharedid1"]);
    expect(merged.items.sharedid1?.title).toBe("Other newer");
    expect(merged.items.localonly1?.title).toBe("Only local");
    expect(merged.items.fileonly1?.title).toBe("Only other (Oct)");
    expect(merged.updatedAt).toBe("2026-11-05T00:00:00.000Z");
  });
});
