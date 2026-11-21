/**
 * Sidebar stash (收纳箱) plugin runtime.
 *
 * Port of ump45nose/codex-stash (MIT) via codex-host renderer-sidebar-stash.
 * Exposes `window.__cxpStashV1` (same shape as fork `TopTabsStash`) for other plugins
 * such as the top tabs strip, and never sets `window.__codexStash_v1` or
 * `window.__codexhostSidebarStashV1`.
 */

import { createSidebarAdapter, type SidebarAdapter } from "./adapter.ts";
import { CHORDS, isEditableTarget, matchChord } from "./hotkey.ts";
import { openDuePopover } from "./popover.ts";
import { browserNotificationPort, createReminderController } from "./reminders.ts";
import { registerReservedHotkeys, STASH_RESERVED_HOTKEYS } from "./reserved-hotkeys.ts";
import { createStashSection } from "./section.ts";
import { createPersistedStore, type StashStorageBackend } from "./storage.ts";
import { StashStore } from "./store.ts";
import { pickStrings } from "./strings.ts";
import { ensureStyles } from "./style.ts";
import { observeComposerSubmission } from "./submission.ts";
import { ThreadIdError } from "./thread-id.ts";

export const STASH_GLOBAL_KEY = "__cxpStashV1";

/** A thread to stash that need not be the open one, e.g. from a top tab. */
export interface StashThreadTarget {
  readonly threadId: string;
  readonly title: string;
  readonly hostId?: string;
}

/** Public surface exposed on `window.__cxpStashV1`, matching fork `TopTabsStash`. */
export interface CxpStashV1 {
  available(): boolean;
  isStashed(threadId: string): boolean;
  stash(target: StashThreadTarget): void;
  unstash(threadId: string): void;
  setRestoreDate(target: StashThreadTarget, anchor: HTMLElement): void;
  subscribe(listener: () => void): () => void;
}

export interface InstallSidebarStashOptions {
  document?: Document;
  window?: Window & typeof globalThis;
  storage?: StashStorageBackend | null;
  getLocale?: () => string | null | undefined;
  adapter?: SidebarAdapter;
  Notification?: typeof Notification;
  logger?: Pick<Console, "info" | "warn" | "debug">;
}

export interface SidebarStashHandle {
  dispose(): void;
  store: StashStore;
  refresh(): void;
  api: CxpStashV1;
  stashThread(target: StashThreadTarget): void;
  /** Stashes the thread if needed, then opens the restore-date picker at `anchor`. */
  openRestoreDate(target: StashThreadTarget, anchor: HTMLElement): void;
}

type StashWindow = Window &
  typeof globalThis & {
    [STASH_GLOBAL_KEY]?: CxpStashV1;
  };

export function installSidebarStash(
  options: InstallSidebarStashOptions = {},
): SidebarStashHandle | null {
  const win = (options.window ?? (typeof window !== "undefined" ? window : undefined)) as
    | StashWindow
    | undefined;
  const doc = options.document ?? (typeof document !== "undefined" ? document : undefined);
  const log = options.logger ?? console;

  if (!win || !doc) return null;
  const ownerDocument = doc;
  const ownerWindow = win;

  const locale = options.getLocale?.() ?? detectLocale(ownerDocument);
  const strings = pickStrings(locale);
  const adapter = options.adapter ?? createSidebarAdapter(ownerDocument);
  const storage: StashStorageBackend | null =
    options.storage === undefined ? safeLocalStorage() : options.storage;
  const { store, migratedFromLegacy } = createPersistedStore(StashStore, { storage });
  if (migratedFromLegacy) {
    log.info?.("[cxp:stash] migrated state from localStorage codex-stash:v1");
  }

  const disposeStyle = ensureStyles(ownerDocument);
  const disposeHotkeys = registerReservedHotkeys(STASH_RESERVED_HOTKEYS);

  let menuEl: HTMLElement | null = null;
  let popoverClose: (() => void) | null = null;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  const section = createStashSection({
    document: ownerDocument,
    strings,
    locale: locale ?? "zh-CN",
    onOpen: (threadId) => {
      void restoreThread(threadId);
    },
    onContextMenu: (threadId, event, anchor) => {
      openRowMenu(threadId, event, anchor);
    },
  });

  const NotificationImpl = options.Notification;
  const reminder = createReminderController(
    NotificationImpl
      ? {
          get permission() {
            return NotificationImpl.permission;
          },
          requestPermission: () => NotificationImpl.requestPermission(),
          notify: (title, opts) => new NotificationImpl(title, opts),
        }
      : browserNotificationPort(),
    {
      strings: {
        overdueTitle: (count) =>
          count === 1 ? strings.notifyTitleOne : strings.notifyTitleMany(count),
      },
    },
  );

  function mountSection(): void {
    const placement =
      typeof adapter.findMountPlacement === "function"
        ? adapter.findMountPlacement()
        : (() => {
            const parent = adapter.findMountPoint();
            return parent ? { parent, after: null, before: null, gap: null } : null;
          })();
    if (!placement?.parent) return;
    const { parent, after = null, before = null, gap = null } = placement;
    // Pin after the Recents (or last) native section on every refresh so React
    // reorders cannot leave us on the outer aside shell.
    if (after && after.parentNode === parent) {
      section.root.style.marginTop = gap || "";
      if (section.root.previousElementSibling !== after) {
        after.after(section.root);
      }
      return;
    }
    if (before && before.parentNode === parent) {
      section.root.style.marginTop = "";
      if (section.root.nextSibling !== before) {
        parent.insertBefore(section.root, before);
      }
      return;
    }
    section.root.style.marginTop = "";
    if (section.root.parentElement !== parent) {
      parent.append(section.root);
    }
  }

  function refresh(): void {
    if (disposed) return;
    mountSection();
    section.render(store.getState());
    reminder.sync(store.getState());
  }

  async function restoreThread(threadId: string, opts: { open?: boolean } = {}): Promise<void> {
    const item = store.get(threadId);
    if (opts.open !== false) {
      const opened = adapter.openThread(threadId);
      if (!opened) {
        log.warn?.("[cxp:stash] thread row not found for", threadId);
      }
    }
    store.remove(threadId);
    if (item?.pin) {
      // Give the sidebar a tick to render the thread before re-pinning.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          resolve();
        }, 0);
        pendingTimers.add(timer);
      });
      if (disposed) return;
      adapter.restorePin(threadId, item.pin);
    }
    refresh();
  }

  function activeTarget(): StashThreadTarget | null {
    const threadId = adapter.readActiveThreadId();
    if (!threadId) {
      log.debug?.("[cxp:stash] no active thread to stash");
      return null;
    }
    return { threadId, title: adapter.readTitle(adapter.findThreadButton(threadId)) };
  }

  function stashThread(target: StashThreadTarget, dueAt?: string | null): boolean {
    const pin = adapter.readPinState(target.threadId) ?? undefined;
    try {
      store.put({
        threadId: target.threadId,
        title: target.title,
        dueAt: dueAt === undefined ? undefined : dueAt,
        pin,
        ...(target.hostId ? { hostId: target.hostId } : {}),
      });
    } catch (error) {
      if (error instanceof ThreadIdError) {
        log.warn?.("[cxp:stash]", error.message);
        return false;
      }
      throw error;
    }
    refresh();
    return true;
  }

  function stashActive(dueAt?: string | null): void {
    const target = activeTarget();
    if (target) stashThread(target, dueAt);
  }

  function toggleActive(): void {
    const threadId = adapter.readActiveThreadId();
    if (!threadId) return;
    if (store.has(threadId)) {
      void restoreThread(threadId);
      return;
    }
    stashActive();
  }

  function jumpOverdue(): void {
    const state = store.getState();
    const now = Date.now();
    for (const [threadId, item] of Object.entries(state.items)) {
      if (item.dueAt && Date.parse(item.dueAt) <= now) {
        void restoreThread(threadId);
        return;
      }
    }
  }

  function openDueForActive(anchor?: HTMLElement): void {
    const target = activeTarget();
    if (target) openDueFor(target, anchor);
  }

  function openDueFor(target: StashThreadTarget, anchor?: HTMLElement): void {
    const { threadId } = target;
    if (!store.has(threadId) && !stashThread(target, null)) return;
    const item = store.get(threadId);
    popoverClose?.();
    const handle = openDuePopover({
      document: ownerDocument,
      strings,
      currentDueAt: item?.dueAt ?? null,
      anchor: anchor ?? fakeAnchor(),
      onSelect: (dueAt) => {
        store.put({ threadId, dueAt });
        refresh();
      },
      onClose: () => {
        popoverClose = null;
      },
    });
    popoverClose = () => handle.close();
  }

  function openRowMenu(threadId: string, event: MouseEvent, anchor: HTMLElement): void {
    closeMenu();
    const menu = ownerDocument.createElement("div");
    menu.setAttribute("data-codexhost-sidebar-stash-menu", "1");
    menu.setAttribute("role", "menu");
    const unstash = ownerDocument.createElement("button");
    unstash.type = "button";
    unstash.textContent = strings.menuUnstash;
    unstash.addEventListener("click", () => {
      closeMenu();
      void restoreThread(threadId);
    });
    const setDue = ownerDocument.createElement("button");
    setDue.type = "button";
    setDue.textContent = strings.menuSetDue;
    setDue.addEventListener("click", () => {
      closeMenu();
      const item = store.get(threadId);
      popoverClose?.();
      const handle = openDuePopover({
        document: ownerDocument,
        strings,
        currentDueAt: item?.dueAt ?? null,
        anchor,
        onSelect: (dueAt) => {
          store.put({ threadId, dueAt });
          refresh();
        },
        onClose: () => {
          popoverClose = null;
        },
      });
      popoverClose = () => handle.close();
    });
    menu.append(unstash, setDue);
    ownerDocument.body.appendChild(menu);
    const viewportWidth = ownerWindow.innerWidth ?? 1024;
    const viewportHeight = ownerWindow.innerHeight ?? 768;
    const left = Math.min(Math.max(8, event.clientX), viewportWidth - 200);
    const top = Math.min(Math.max(8, event.clientY), viewportHeight - 100);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menuEl = menu;
    const onPointer = (ev: MouseEvent): void => {
      if (typeof Node !== "undefined" && ev.target instanceof Node && menu.contains(ev.target)) {
        return;
      }
      closeMenu();
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") closeMenu();
    };
    ownerDocument.addEventListener("mousedown", onPointer, true);
    ownerDocument.addEventListener("keydown", onKey, true);
    (menu as HTMLElement & { __cleanup?: () => void }).__cleanup = () => {
      ownerDocument.removeEventListener("mousedown", onPointer, true);
      ownerDocument.removeEventListener("keydown", onKey, true);
    };
  }

  function closeMenu(): void {
    if (!menuEl) return;
    const cleanup = (menuEl as HTMLElement & { __cleanup?: () => void }).__cleanup;
    cleanup?.();
    menuEl.remove();
    menuEl = null;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (isEditableTarget(event.target)) return;
    if (matchChord(event, CHORDS.stash)) {
      event.preventDefault();
      event.stopPropagation();
      toggleActive();
      return;
    }
    if (matchChord(event, CHORDS.due)) {
      event.preventDefault();
      event.stopPropagation();
      openDueForActive();
      return;
    }
    if (matchChord(event, CHORDS.jump)) {
      event.preventDefault();
      event.stopPropagation();
      jumpOverdue();
    }
  }

  function onComposerSubmission(): void {
    const threadId = adapter.readActiveThreadId();
    if (!threadId || !store.has(threadId)) return;
    void restoreThread(threadId, { open: false });
  }

  function onContextMenu(event: MouseEvent): void {
    const target = event.target;
    if (!target || typeof (target as Element).closest !== "function") return;
    const el = target as Element;
    if (el.closest("[data-codexhost-sidebar-stash-root]")) return;
    const button = el.closest<HTMLElement>("[data-app-action-sidebar-thread-id]");
    if (!button || button.hasAttribute("data-codexhost-sidebar-thread-mirror")) return;
    const threadId = adapter.readThreadId(button);
    if (!threadId) return;
    // Augment native menu lightly: Shift+contextmenu stashes.
    if (!event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (store.has(threadId)) {
      void restoreThread(threadId);
      return;
    }
    const title = adapter.readTitle(button);
    const pin = adapter.readPinState(threadId) ?? undefined;
    store.put({ threadId, title, pin });
    refresh();
  }

  let disposed = false;

  const unsubscribe = store.subscribe(() => {
    section.render(store.getState());
    reminder.sync(store.getState());
  });
  const stopObserve = adapter.observe(() => {
    refresh();
  });
  const stopSubmission = observeComposerSubmission(ownerDocument, onComposerSubmission);

  ownerDocument.addEventListener("keydown", onKeyDown, true);
  ownerDocument.addEventListener("contextmenu", onContextMenu, true);

  const api: CxpStashV1 = {
    available: () => !disposed,
    isStashed: (threadId) => !disposed && store.has(threadId),
    stash: (target) => {
      if (!disposed) stashThread(target);
    },
    unstash: (threadId) => {
      if (!disposed && store.remove(threadId)) refresh();
    },
    setRestoreDate: (target, anchor) => {
      if (!disposed) openDueFor(target, anchor);
    },
    subscribe: (listener) => {
      if (disposed) return () => {};
      return store.subscribe(() => listener());
    },
  };

  ownerWindow[STASH_GLOBAL_KEY] = api;

  refresh();

  const handle: SidebarStashHandle = {
    store,
    refresh,
    api,
    stashThread: (target) => void stashThread(target),
    openRestoreDate: (target, anchor) => openDueFor(target, anchor),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      closeMenu();
      popoverClose?.();
      unsubscribe();
      stopObserve();
      stopSubmission();
      reminder.dispose();
      disposeStyle();
      disposeHotkeys();
      section.dispose();
      ownerDocument.removeEventListener("keydown", onKeyDown, true);
      ownerDocument.removeEventListener("contextmenu", onContextMenu, true);
      if (ownerWindow[STASH_GLOBAL_KEY] === api) {
        Reflect.deleteProperty(ownerWindow, STASH_GLOBAL_KEY);
      }
    },
  };

  return handle;
}

function detectLocale(doc: Document): string {
  return (
    doc.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : "en")
  );
}

function safeLocalStorage(): StashStorageBackend | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function fakeAnchor(): { getBoundingClientRect(): DOMRect } {
  return {
    getBoundingClientRect: () =>
      ({
        x: 24,
        y: 80,
        top: 80,
        left: 24,
        bottom: 80,
        right: 24,
        width: 0,
        height: 0,
        toJSON() {
          return this;
        },
      }) as DOMRect,
  };
}
