import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../../../plugins/vertical/plugin.ts";
import activate from "../../../plugins/vertical/page.ts";
import {
  CXP_STASH_GLOBAL_KEY,
  TOP_TAB_ATTRIBUTE,
  TOP_TAB_CONTEXT_MENU_ATTRIBUTE,
  TOP_TAB_STASH_ATTRIBUTE,
  TOP_TABS_ROOT_ATTRIBUTE,
  TOP_TABS_STYLE_ID,
  type TopTabsStash,
  type TopTabsStashTarget,
} from "../../../plugins/vertical/top-tabs/index.ts";
import type { PluginApi } from "../../../plugins/types.ts";
import { FakeDocument, FakeWindow, installFakeMutationObserver } from "./fake-dom.ts";

let restoreObserver: (() => void) | null = null;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  restoreObserver = installFakeMutationObserver();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  Reflect.deleteProperty(globalThis, "__codexhostHostRoutingV1");
  restoreObserver?.();
  restoreObserver = null;
});

function createPluginFixture(width = 1280) {
  const doc = new FakeDocument();
  doc.documentElement.lang = "zh-CN";
  const win = new FakeWindow(doc, width);

  const frame = doc.createElement("div");
  frame.setAttribute("data-app-shell-frame", "true");
  frame.setAttribute("data-app-shell-sidebar-open", "true");
  const trigger = doc.createElement("button");
  trigger.setAttribute("data-app-shell-sidebar-trigger", "true");
  let triggerClicks = 0;
  trigger.addEventListener("click", () => {
    triggerClicks += 1;
    const isOpen = frame.getAttribute("data-app-shell-sidebar-open") === "true";
    frame.setAttribute("data-app-shell-sidebar-open", isOpen ? "false" : "true");
  });
  frame.appendChild(trigger);

  const scroll = doc.createElement("div");
  scroll.setAttribute("data-app-action-sidebar-scroll", "");
  const row = doc.createElement("div");
  row.setAttribute("data-app-action-sidebar-thread-row", "true");
  row.setAttribute("data-app-action-sidebar-thread-id", "local:thread-1");
  row.setAttribute("data-app-action-sidebar-thread-host-id", "local");
  row.setAttribute("data-app-action-sidebar-thread-title", "Fix vertical tabs");
  row.setAttribute("data-sidebar-indicator", "working");
  scroll.appendChild(row);

  const activePage = doc.createElement("div");
  activePage.setAttribute("data-app-shell-active-page", "true");
  const main = doc.createElement("main");
  main.setAttribute("data-app-shell-main-surface", "default");
  activePage.appendChild(main);

  doc.body.append(frame, scroll, activePage);

  return {
    doc,
    win,
    frame,
    scroll,
    row,
    getTriggerClicks: () => triggerClicks,
  };
}

function makeApi(settings: Record<string, unknown> = {}): PluginApi {
  return {
    id: "vertical",
    window: "main",
    settings,
    request: vi.fn(async () => null),
    fail: vi.fn(),
    log: vi.fn(),
  };
}

function createFakeStash() {
  const stashed = new Set<string>();
  const listeners = new Set<() => void>();
  let isAvailable = true;
  const stashFn = vi.fn((target: TopTabsStashTarget) => {
    stashed.add(target.threadId);
    for (const l of listeners) l();
  });
  const unstashFn = vi.fn((threadId: string) => {
    stashed.delete(threadId);
    for (const l of listeners) l();
  });
  const setRestoreDateFn = vi.fn();

  const api: TopTabsStash = {
    available: () => isAvailable,
    isStashed: (threadId) => stashed.has(threadId),
    stash: stashFn,
    unstash: unstashFn,
    setRestoreDate: setRestoreDateFn,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    api,
    stashed,
    stashFn,
    unstashFn,
    setRestoreDateFn,
    setAvailable: (next: boolean) => {
      isAvailable = next;
      for (const l of listeners) l();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("vertical plugin manifest", () => {
  it("declares main window, settings, and no false-positive forkGuards", () => {
    expect(manifest.id).toBe("vertical");
    expect(manifest.name).toBe("竖屏");
    expect(manifest.windows).toEqual(["main"]);
    expect(manifest.page).toBe("./page.ts");
    expect(manifest.forkGuards).toEqual([]);
    expect(manifest.settings?.map((s) => [s.key, s.type, s.default])).toEqual([
      ["sidebarAutoCollapse", "toggle", true],
      ["sidebarOverlayBreakpoint", "number", 1080],
      ["topTabsEnabled", "toggle", true],
      ["topTabsTwoRows", "toggle", true],
    ]);
  });
});

describe("vertical plugin activation, cleanup, stash bridge, and Host ownership", () => {
  it("activates sidebar overlay + top tabs with settings and cleans up completely", () => {
    const fixture = createPluginFixture(900);
    const cleanup = activate(
      makeApi({
        sidebarAutoCollapse: true,
        sidebarOverlayBreakpoint: 1080,
        topTabsEnabled: true,
        topTabsTwoRows: true,
      }),
      {
        document: fixture.doc as unknown as Document,
        window: fixture.win as unknown as Window,
      },
    );
    cleanups.push(cleanup);

    expect(fixture.getTriggerClicks()).toBe(1);
    expect(fixture.frame.getAttribute("data-app-shell-sidebar-open")).toBe("false");
    expect(fixture.doc.querySelector(`[${TOP_TABS_ROOT_ATTRIBUTE}]`)).not.toBeNull();
    expect(fixture.doc.getElementById(TOP_TABS_STYLE_ID)).not.toBeNull();
    expect(fixture.doc.querySelectorAll(`[${TOP_TAB_ATTRIBUTE}]`)).toHaveLength(1);

    cleanup();
    expect(fixture.doc.querySelector(`[${TOP_TABS_ROOT_ATTRIBUTE}]`)).toBeNull();
    expect(fixture.doc.getElementById(TOP_TABS_STYLE_ID)).toBeNull();
  });

  it("hides stash controls when __cxpStashV1 is absent or unavailable, and stashes via right-click when available", async () => {
    const fixture = createPluginFixture(1280);
    const loaderListeners = new Set<() => void>();
    fixture.win.__cxpLoaderV1 = {
      subscribe: (listener: () => void) => {
        loaderListeners.add(listener);
        return () => loaderListeners.delete(listener);
      },
    };
    const notifyLoader = () => {
      for (const l of loaderListeners) l();
    };

    const cleanup = activate(makeApi(), {
      document: fixture.doc as unknown as Document,
      window: fixture.win as unknown as Window,
    });
    cleanups.push(cleanup);

    // 1. No __cxpStashV1 -> no hover stash button and no context menu
    let tab = fixture.doc.querySelector(`[${TOP_TAB_ATTRIBUTE}="local:thread-1"]`);
    expect(tab).not.toBeNull();
    expect(tab?.querySelector(`[${TOP_TAB_STASH_ATTRIBUTE}]`)).toBeNull();
    tab?.dispatchEvent(new Event("contextmenu", { bubbles: true, cancelable: true }));
    expect(fixture.doc.querySelector(`[${TOP_TAB_CONTEXT_MENU_ATTRIBUTE}]`)).toBeNull();

    // 2. Stash plugin turns on -> __cxpStashV1 appears and loader notifies
    const fakeStash = createFakeStash();
    fixture.win[CXP_STASH_GLOBAL_KEY] = fakeStash.api;
    notifyLoader();
    await settle();

    tab = fixture.doc.querySelector(`[${TOP_TAB_ATTRIBUTE}="local:thread-1"]`);
    expect(tab?.querySelector(`[${TOP_TAB_STASH_ATTRIBUTE}]`)).not.toBeNull();

    // Right-click opens context menu and clicking "收纳" stashes the thread and removes it from strip
    const ctxEvent = new Event("contextmenu", { bubbles: true, cancelable: true });
    Object.assign(ctxEvent, { clientX: 120, clientY: 60 });
    tab?.dispatchEvent(ctxEvent);
    const menu = fixture.doc.querySelector(`[${TOP_TAB_CONTEXT_MENU_ATTRIBUTE}]`);
    expect(menu).not.toBeNull();
    const stashBtn = menu?.querySelector('button[role="menuitem"]');
    expect(stashBtn?.textContent).toBe("收纳");
    stashBtn?.click();
    expect(fakeStash.stashFn).toHaveBeenCalledWith({
      hostId: "local",
      threadId: "thread-1",
      title: "Fix vertical tabs",
    });
    await settle();
    expect(fixture.doc.querySelector(`[${TOP_TAB_ATTRIBUTE}="local:thread-1"]`)).toBeNull();

    // 3. Unstashing brings it back; turning stash plugin off hides the entry again
    fakeStash.api.unstash("thread-1");
    await settle();
    expect(fixture.doc.querySelector(`[${TOP_TAB_ATTRIBUTE}="local:thread-1"]`)).not.toBeNull();

    Reflect.deleteProperty(fixture.win, CXP_STASH_GLOBAL_KEY);
    notifyLoader();
    await settle();
    tab = fixture.doc.querySelector(`[${TOP_TAB_ATTRIBUTE}="local:thread-1"]`);
    expect(tab?.querySelector(`[${TOP_TAB_STASH_ATTRIBUTE}]`)).toBeNull();
  });

  it("queries codexhost/thread/ownership/list and codexhost/harness/plugins/list via shared/host", async () => {
    const sendRequest = vi.fn(async (method: string, params?: unknown) => {
      if (method === "codexhost/thread/ownership/list") {
        expect(params).toEqual({ threadIds: ["thread-1"] });
        return { threads: [{ threadId: "thread-1", owner: "claude" }] };
      }
      if (method === "codexhost/harness/plugins/list") {
        return {
          plugins: [
            {
              id: "claude",
              name: "Claude Code",
              iconStyle: {
                vector: { color: "#d97757", paths: [{ d: "M0 0h10v10H0z" }] },
              },
            },
          ],
        };
      }
      return null;
    });
    (globalThis as Record<string, unknown>).__codexhostHostRoutingV1 = {
      forHost: () => ({ manager: { sendRequest } }),
    };

    const fixture = createPluginFixture(1280);
    const cleanup = activate(makeApi(), {
      document: fixture.doc as unknown as Document,
      window: fixture.win as unknown as Window,
    });
    cleanups.push(cleanup);

    await settle();
    expect(sendRequest).toHaveBeenCalledWith("codexhost/thread/ownership/list", {
      threadIds: ["thread-1"],
    });
    expect(sendRequest).toHaveBeenCalledWith("codexhost/harness/plugins/list", {});

    const iconSvg = fixture.doc.querySelector(".codexhost-session-tab-icon svg");
    expect(iconSvg).not.toBeNull();
    expect(iconSvg?.style.fill).toBe("#d97757");
  });
});
