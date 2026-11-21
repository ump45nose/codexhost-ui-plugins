import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIDEBAR_AUTO_COLLAPSE,
  DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT,
  SIDEBAR_AUTO_COLLAPSE_STORAGE_KEY,
  SIDEBAR_OVERLAY_MODE_STORAGE_KEY,
  SIDEBAR_PIN_BUTTON_ATTRIBUTE,
  buildSidebarOverlayCss,
  installRendererSidebarOverlay,
  readSidebarAutoCollapsePreference,
  setSidebarAutoCollapsePreference,
  subscribeSidebarAutoCollapsePreference,
  writeSidebarAutoCollapsePreference,
} from "../../../plugins/vertical/sidebar-overlay/index.ts";
import { FakeDocument, FakeWindow } from "./fake-dom.ts";

function createTestEnvironment(initialWidth = 1140) {
  const doc = new FakeDocument();
  const win = new FakeWindow(doc, initialWidth);

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

  const floatingPanel = doc.createElement("div");
  floatingPanel.setAttribute("data-testid", "app-shell-floating-left-panel");

  frame.appendChild(trigger);
  frame.appendChild(floatingPanel);
  doc.body.appendChild(frame);

  return {
    doc: doc as unknown as Document,
    win: win as unknown as Window,
    frame,
    trigger,
    floatingPanel,
    getTriggerClicks: () => triggerClicks,
    resizeTo: (width: number) => {
      win.innerWidth = width;
      win.dispatchEvent(new Event("resize"));
    },
  };
}

describe("sidebar auto-collapse preference and migration", () => {
  it("defaults to auto-collapse enabled and 1080px breakpoint", () => {
    const env = createTestEnvironment();
    expect(DEFAULT_SIDEBAR_AUTO_COLLAPSE).toBe(true);
    expect(DEFAULT_SIDEBAR_OVERLAY_BREAKPOINT).toBe(1080);
    expect(readSidebarAutoCollapsePreference(env.win)).toBe(true);
  });

  it("migrates legacy docked/auto storage keys into the boolean preference", () => {
    const env = createTestEnvironment();
    env.win.localStorage.setItem(SIDEBAR_OVERLAY_MODE_STORAGE_KEY, "docked");
    expect(readSidebarAutoCollapsePreference(env.win)).toBe(false);
    expect(env.win.localStorage.getItem(SIDEBAR_AUTO_COLLAPSE_STORAGE_KEY)).toBe("false");
    expect(env.win.localStorage.getItem(SIDEBAR_OVERLAY_MODE_STORAGE_KEY)).toBeNull();

    env.win.localStorage.setItem(SIDEBAR_OVERLAY_MODE_STORAGE_KEY, "auto");
    expect(readSidebarAutoCollapsePreference(env.win)).toBe(true);
    expect(env.win.localStorage.getItem(SIDEBAR_AUTO_COLLAPSE_STORAGE_KEY)).toBe("true");
  });

  it("writes preference and notifies subscribers", () => {
    const env = createTestEnvironment();
    const listener = vi.fn();
    const unsubscribe = subscribeSidebarAutoCollapsePreference(env.win, listener);

    writeSidebarAutoCollapsePreference(false, env.win, env.win);
    expect(readSidebarAutoCollapsePreference(env.win)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    setSidebarAutoCollapsePreference(env.win, true);
    expect(readSidebarAutoCollapsePreference(env.win)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setSidebarAutoCollapsePreference(env.win, false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("installRendererSidebarOverlay", () => {
  it("collapses once when crossing into < 1080px and respects manual dock expansion", () => {
    const env = createTestEnvironment(1140);
    const handle = installRendererSidebarOverlay({
      document: env.doc,
      window: env.win,
    });

    expect(env.getTriggerClicks()).toBe(0);
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("true");
    expect(handle.isNarrowViewport()).toBe(false);

    // Entering < 1080px triggers one native collapse.
    env.resizeTo(954);
    expect(handle.isNarrowViewport()).toBe(true);
    expect(env.getTriggerClicks()).toBe(1);
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("false");

    // User manually re-opens sidebar at 954px: stays docked across narrow resizes and refreshes.
    env.trigger.click();
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("true");
    expect(env.getTriggerClicks()).toBe(2);

    env.resizeTo(800);
    handle.refresh();
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("true");
    expect(env.getTriggerClicks()).toBe(2);

    // Re-crossing >= 1080px -> < 1080px triggers one collapse again.
    env.resizeTo(1140);
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("true");
    env.resizeTo(954);
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("false");
    expect(env.getTriggerClicks()).toBe(3);

    handle.dispose();
  });

  it("collapses once on initial mount when starting in a narrow viewport (< 1080px)", () => {
    const env = createTestEnvironment(954);
    const handle = installRendererSidebarOverlay({
      document: env.doc,
      window: env.win,
    });

    expect(env.getTriggerClicks()).toBe(1);
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("false");
    handle.dispose();
  });

  it("does not collapse when preference is disabled or migrated from docked", () => {
    const env = createTestEnvironment(1140);
    env.win.localStorage.setItem(SIDEBAR_OVERLAY_MODE_STORAGE_KEY, "docked");

    const handle = installRendererSidebarOverlay({
      document: env.doc,
      window: env.win,
    });

    env.resizeTo(954);
    expect(env.getTriggerClicks()).toBe(0);
    expect(env.frame.getAttribute("data-app-shell-sidebar-open")).toBe("true");
    handle.dispose();
  });

  it("removes custom overlay CSS, never hides app-shell-floating-left-panel, and injects no pin button", () => {
    expect(buildSidebarOverlayCss()).toBe("");

    const env = createTestEnvironment(954);
    const handle = installRendererSidebarOverlay({
      document: env.doc,
      window: env.win,
    });

    expect(env.doc.querySelectorAll(`[${SIDEBAR_PIN_BUTTON_ATTRIBUTE}]`)).toHaveLength(0);
    expect(env.floatingPanel.style.display).toBeUndefined();
    expect(env.doc.documentElement.hasAttribute("data-codexhost-sidebar-overlay")).toBe(false);
    handle.dispose();
  });

  it("supports explicit breakpoint and autoCollapse overrides from plugin settings", () => {
    const env = createTestEnvironment(900);
    const handle = installRendererSidebarOverlay({
      document: env.doc,
      window: env.win,
      autoCollapse: true,
      breakpoint: 800,
    });

    expect(handle.isNarrowViewport()).toBe(false);
    expect(env.getTriggerClicks()).toBe(0);

    env.resizeTo(750);
    expect(handle.isNarrowViewport()).toBe(true);
    expect(env.getTriggerClicks()).toBe(1);
    handle.dispose();
  });
});
