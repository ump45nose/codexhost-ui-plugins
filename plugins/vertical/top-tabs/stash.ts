import type { TopTabStatus } from "./index.ts";

export const TOP_TAB_STASH_ATTRIBUTE = "data-codexhost-top-tab-stash";
export const TOP_TAB_CONTEXT_MENU_ATTRIBUTE = "data-cxp-top-tab-context-menu";
export const CXP_STASH_GLOBAL_KEY = "__cxpStashV1";

export interface TopTabsStashTarget {
  readonly hostId: string;
  readonly threadId: string;
  readonly title: string;
}

/** The sidebar stash (收纳箱) as the strip sees it; the stash may be turned off or remounted. */
export interface TopTabsStash {
  available(): boolean;
  isStashed(threadId: string): boolean;
  stash(target: TopTabsStashTarget): void;
  unstash(threadId: string): void;
  setRestoreDate(target: TopTabsStashTarget, anchor: HTMLElement): void;
  subscribe(listener: () => void): () => void;
}

interface LoaderLike {
  subscribe?(listener: () => void): () => void;
}

function readWindowStash(win: Window): TopTabsStash | null {
  const candidate = (win as unknown as Record<string, unknown>)[CXP_STASH_GLOBAL_KEY];
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof (candidate as TopTabsStash).available === "function" &&
    typeof (candidate as TopTabsStash).isStashed === "function" &&
    typeof (candidate as TopTabsStash).stash === "function" &&
    typeof (candidate as TopTabsStash).unstash === "function" &&
    typeof (candidate as TopTabsStash).setRestoreDate === "function" &&
    typeof (candidate as TopTabsStash).subscribe === "function"
  ) {
    return candidate as TopTabsStash;
  }
  return null;
}

/**
 * Dynamic bridge to `window.__cxpStashV1` exposed by the `stash` plugin.
 * Reacts automatically when `stash` is turned on or off via `window.__cxpLoaderV1`.
 */
export function createWindowCxpStashBridge(win: Window): TopTabsStash {
  return {
    available: () => Boolean(readWindowStash(win)?.available()),
    isStashed: (threadId) => Boolean(readWindowStash(win)?.isStashed(threadId)),
    stash: (target) => {
      readWindowStash(win)?.stash(target);
    },
    unstash: (threadId) => {
      readWindowStash(win)?.unstash(threadId);
    },
    setRestoreDate: (target, anchor) => {
      readWindowStash(win)?.setRestoreDate(target, anchor);
    },
    subscribe: (listener) => {
      let boundStash: TopTabsStash | null = null;
      let unbindStash: (() => void) | null = null;
      const syncBinding = (notify: boolean): void => {
        const current = readWindowStash(win);
        if (current !== boundStash) {
          unbindStash?.();
          unbindStash = null;
          boundStash = current;
          if (boundStash) {
            unbindStash = boundStash.subscribe(listener);
          }
          if (notify) listener();
        } else if (notify) {
          listener();
        }
      };
      syncBinding(false);
      const loader = (win as unknown as { __cxpLoaderV1?: LoaderLike }).__cxpLoaderV1;
      const unbindLoader =
        typeof loader?.subscribe === "function"
          ? loader.subscribe(() => syncBinding(true))
          : null;
      return () => {
        unbindStash?.();
        unbindStash = null;
        boundStash = null;
        unbindLoader?.();
      };
    },
  };
}

/** A reply, a request for input, or a failure brings a stashed session back. */
const NEWS: ReadonlySet<TopTabStatus> = new Set(["waiting", "unread", "failed"]);

/**
 * Hides stashed sessions from the strip. A stashed session whose status turns to news after
 * the strip has seen it leaves the stash, so it shows again and the stash box stays truthful.
 */
export function createStashedSessionFilter(
  stash: TopTabsStash | undefined,
): (key: string, threadId: string, status: TopTabStatus) => boolean {
  const lastStatus = new Map<string, TopTabStatus>();
  return (key, threadId, status) => {
    const previous = lastStatus.get(key);
    lastStatus.set(key, status);
    if (!stash?.available() || !stash.isStashed(threadId)) return false;
    if (previous !== undefined && previous !== status && NEWS.has(status)) {
      stash.unstash(threadId);
      return false;
    }
    return true;
  };
}

function strings(locale: string): { stash: string; restoreDate: string } {
  return locale.startsWith("zh")
    ? { stash: "收纳", restoreDate: "设置恢复日期…" }
    : { stash: "Stash", restoreDate: "Set restore date…" };
}

const STASH_ICON_PATH =
  "M2.5 4.5h11M3.5 4.5v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7M2.5 2.5h11v2h-11zM6.5 7h3";

/** Revealed on hover; a span because a tab is already a button. */
export function createTabStashControl(
  doc: Document,
  target: TopTabsStashTarget,
  stash: TopTabsStash,
  locale: string,
): HTMLElement {
  const control = doc.createElement("span");
  control.className = "codexhost-session-tab-stash";
  control.setAttribute(TOP_TAB_STASH_ATTRIBUTE, "true");
  control.setAttribute("role", "button");
  const label = strings(locale).stash;
  control.setAttribute("aria-label", label);
  control.title = label;
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", STASH_ICON_PATH);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  control.appendChild(svg);
  control.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    stash.stash(target);
  });
  return control;
}

/** Opens the tab's right-click menu at the pointer; it closes on choice, Escape, or outside click. */
export function openTabContextMenu(input: {
  readonly doc: Document;
  readonly event: MouseEvent;
  readonly anchor: HTMLElement;
  readonly target: TopTabsStashTarget;
  readonly stash: TopTabsStash;
  readonly locale: string;
}): void {
  const { doc, event, anchor, target, stash } = input;
  closeTabContextMenu(doc);
  const text = strings(input.locale);
  const menu = doc.createElement("div");
  menu.setAttribute(TOP_TAB_CONTEXT_MENU_ATTRIBUTE, "true");
  menu.setAttribute("role", "menu");
  const item = (label: string, choose: () => void): HTMLButtonElement => {
    const button = doc.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.addEventListener("click", () => {
      closeTabContextMenu(doc);
      choose();
    });
    return button;
  };
  menu.append(
    item(text.stash, () => stash.stash(target)),
    item(text.restoreDate, () => stash.setRestoreDate(target, anchor)),
  );
  doc.body.appendChild(menu);
  const view = doc.defaultView;
  const width = view?.innerWidth ?? 1024;
  const height = view?.innerHeight ?? 768;
  menu.style.left = `${Math.min(Math.max(8, event.clientX), width - 200)}px`;
  menu.style.top = `${Math.min(Math.max(8, event.clientY), height - 96)}px`;

  const onPointerDown = (ev: Event): void => {
    const targetNode = ev.target as Node | null;
    if (targetNode && typeof menu.contains === "function" && menu.contains(targetNode)) return;
    closeTabContextMenu(doc);
  };
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") closeTabContextMenu(doc);
  };
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);
  activeMenuCleanups.set(doc, () => {
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    menu.remove();
  });
}

const activeMenuCleanups = new WeakMap<Document, () => void>();

export function closeTabContextMenu(doc: Document): void {
  activeMenuCleanups.get(doc)?.();
  activeMenuCleanups.delete(doc);
  for (const menu of doc.querySelectorAll(`[${TOP_TAB_CONTEXT_MENU_ATTRIBUTE}]`)) {
    menu.remove();
  }
}
