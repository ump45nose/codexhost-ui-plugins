import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLoader } from "../../loader/core.ts";
import { PANEL_ID } from "../../loader/ui/panel.ts";
import { RAIL_ENTRY_ID } from "../../loader/ui/rail-entry.ts";
import { STYLE_ID, UI_CSS } from "../../loader/ui/style.ts";
import { TOAST_ID } from "../../loader/ui/toast.ts";
import { FakeDocument, FakeElement, fakeWindow } from "./fake-window.ts";

class FakeMutationObserver {
  private cb: () => void;
  private doc: FakeDocument | null = null;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe(target: FakeElement): void {
    // Walk up to find owning document via any registered doc reference.
    this.doc = activeDoc;
    this.doc?.mutationCallbacks.add(this.cb);
    void target;
  }
  disconnect(): void {
    this.doc?.mutationCallbacks.delete(this.cb);
    this.doc = null;
  }
}

let activeDoc: FakeDocument | null = null;
const origMutationObserver = globalThis.MutationObserver;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T10:00:00.000Z"));
  (globalThis as any).MutationObserver = FakeMutationObserver;
});

afterEach(() => {
  activeDoc = null;
  (globalThis as any).MutationObserver = origMutationObserver;
  vi.useRealTimers();
});

function setupWithRail(kind: "main" | "pet" = "main") {
  const page = fakeWindow(kind);
  activeDoc = page.doc;
  const nav = page.doc.createElement("nav");
  nav.setAttribute("aria-label", "App navigation");
  const topIcon = page.doc.createElement("button");
  topIcon.textContent = "⌂";
  const bang = page.doc.createElement("button");
  bang.textContent = "!";
  const avatar = page.doc.createElement("button");
  avatar.textContent = "◉";
  nav.append(topIcon, bang, avatar);
  page.doc.body.append(nav);
  startLoader(page.win, "51f19c9");
  return { ...page, nav, bang, avatar };
}

describe("plugin panel (C2.1)", () => {
  it("skips render while hidden, then renders null daemon state and all plugin statuses when opened", () => {
    const page = setupWithRail();
    const entry = page.doc.getElementById(RAIL_ENTRY_ID)!;
    const panel = page.doc.getElementById(PANEL_ID)!;
    expect(panel).not.toBeNull();
    expect(panel.hidden).toBe(true);
    expect(panel.querySelectorAll(".cxp-row")).toHaveLength(0);

    entry.click();
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain("正在连接常驻程序");
    expect(panel.textContent).toContain("版本 51f19c9 · 尚未检查更新");

    page.win.__forkStash = {};
    page.register("stash", () => {}, ["__forkStash"]);
    page.push(
      [
        { id: "stash", name: "收纳箱", enabled: true, status: "active" },
        { id: "vertical", name: "竖屏", enabled: true, status: "active" },
        { id: "pet", name: "Pet", enabled: true, status: "failed", source: "rewriter", reason: "Pet 代码块改写没有命中" },
        { id: "picker", name: "项目选择器", enabled: false, status: "off" },
      ],
      { buildId: "51f19c9", update: { checkedAt: "2026-11-21T09:57:00.000Z" } },
    );

    const rows = panel.querySelectorAll(".cxp-row");
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain("收纳箱");
    expect(rows[0].querySelector(".cxp-status")?.textContent).toBe("休眠");
    expect(rows[1].textContent).toContain("竖屏");
    expect(rows[1].querySelector(".cxp-status")?.textContent).toBe("正常");
    expect(rows[2].textContent).toContain("Pet");
    expect(rows[2].querySelector(".cxp-status")?.textContent).toBe("已停用");
    expect(rows[2].querySelector(".cxp-reason")?.textContent).toContain("Pet 代码块改写没有命中");
    expect(rows[3].textContent).toContain("项目选择器");
    expect(rows[3].querySelector(".cxp-status")?.textContent).toBe("已关闭");
    expect(panel.querySelector("footer")?.textContent).toBe("版本 51f19c9 · 3 分钟前检查更新");
  });

  it("toggles enable switch and calls setEnabled, and clicks retry to call retry", () => {
    const page = setupWithRail();
    page.doc.getElementById(RAIL_ENTRY_ID)!.click();
    page.push([
      { id: "stash", name: "收纳箱", enabled: true, status: "active" },
      { id: "pet", name: "Pet", enabled: true, status: "failed", source: "rewriter", reason: "chunk changed" },
    ]);

    const panel = page.doc.getElementById(PANEL_ID)!;
    const stashSwitch = panel.querySelector('[data-plugin-id="stash"]')?.querySelector(".cxp-sw")!;
    expect(stashSwitch.classList.contains("on")).toBe(true);
    stashSwitch.click();
    expect(page.sent.at(-1)).toEqual({ type: "enable", plugin: "stash", enabled: false });

    const stashSwitchAfter = panel.querySelector('[data-plugin-id="stash"]')?.querySelector(".cxp-sw")!;
    expect(stashSwitchAfter.classList.contains("on")).toBe(false);
    stashSwitchAfter.click();
    expect(page.sent.at(-1)).toEqual({ type: "enable", plugin: "stash", enabled: true });

    const retryBtn = panel.querySelector('[data-plugin-id="pet"]')?.querySelector(".cxp-reason")?.querySelector("button")!;
    expect(retryBtn.textContent).toBe("重试");
    retryBtn.click();
    expect(page.sent.at(-1)).toEqual({ type: "retry", plugin: "pet" });
  });

  it("renders and commits text, toggle, number (with min/max/step), and exclude-list settings", () => {
    const page = setupWithRail();
    page.doc.getElementById(RAIL_ENTRY_ID)!.click();
    page.push([
      {
        id: "demo",
        name: "演示插件",
        enabled: true,
        status: "active",
        settings: {
          dir: "~/Developer",
          compact: false,
          width: 900,
          exclude: ["Kiro"],
        },
        settingFields: [
          { key: "dir", type: "text", label: "默认目录", default: "" },
          { key: "compact", type: "toggle", label: "紧凑模式", default: false },
          { key: "width", type: "number", label: "断点宽度", default: 900, min: 400, max: 1600, step: 50 },
          { key: "exclude", type: "exclude-list", label: "排除目标", options: ["Claude Code", "Gemini", "Kiro"], default: [] },
        ],
      },
    ]);

    const panel = page.doc.getElementById(PANEL_ID)!;

    // text (also verify focus and selection survive background state push)
    const textInput = panel.querySelector('[data-cxp-field="demo:dir"]')!;
    expect(textInput.value).toBe("~/Developer");
    textInput.focus();
    textInput.value = "~/Work";
    textInput.setSelectionRange(2, 6);
    page.push([
      {
        id: "demo",
        name: "演示插件",
        enabled: true,
        status: "active",
        settings: { dir: "~/Developer", compact: false, width: 900, exclude: ["Kiro"] },
        settingFields: [
          { key: "dir", type: "text", label: "默认目录", default: "" },
          { key: "compact", type: "toggle", label: "紧凑模式", default: false },
          { key: "width", type: "number", label: "断点宽度", default: 900, min: 400, max: 1600, step: 50 },
          { key: "exclude", type: "exclude-list", label: "排除目标", options: ["Claude Code", "Gemini", "Kiro"], default: [] },
        ],
      },
    ]);
    const textInputAfter = panel.querySelector('[data-cxp-field="demo:dir"]')!;
    expect(page.doc.activeElement).toBe(textInputAfter);
    expect(textInputAfter.value).toBe("~/Work");
    expect(textInputAfter.selectionStart).toBe(2);
    expect(textInputAfter.selectionEnd).toBe(6);
    textInputAfter.dispatchEvent({ type: "change" });
    expect(page.sent.at(-1)).toEqual({ type: "settings:set", plugin: "demo", values: { dir: "~/Work" } });

    // toggle
    const toggleSw = panel.querySelector('[data-cxp-field="demo:compact"]')!;
    expect(toggleSw.classList.contains("on")).toBe(false);
    toggleSw.click();
    expect(page.sent.at(-1)).toEqual({ type: "settings:set", plugin: "demo", values: { compact: true } });

    // number (min/max/step + clamping)
    const numInput = panel.querySelector('[data-cxp-field="demo:width"]')!;
    expect(numInput.getAttribute("min")).toBe("400");
    expect(numInput.getAttribute("max")).toBe("1600");
    expect(numInput.getAttribute("step")).toBe("50");
    numInput.value = "1100";
    numInput.dispatchEvent({ type: "change" });
    expect(page.sent.at(-1)).toEqual({ type: "settings:set", plugin: "demo", values: { width: 1100 } });

    const numInput2 = panel.querySelector('[data-cxp-field="demo:width"]')!;
    numInput2.value = "200"; // below min=400 -> clamped to 400
    numInput2.dispatchEvent({ type: "change" });
    expect(page.sent.at(-1)).toEqual({ type: "settings:set", plugin: "demo", values: { width: 400 } });

    // exclude-list
    const kiroChip = panel.querySelector('[data-cxp-chip="Kiro"]')!;
    const geminiChip = panel.querySelector('[data-cxp-chip="Gemini"]')!;
    expect(kiroChip.classList.contains("off")).toBe(true);
    expect(geminiChip.classList.contains("off")).toBe(false);
    geminiChip.click();
    expect(page.sent.at(-1)).toEqual({ type: "settings:set", plugin: "demo", values: { exclude: ["Kiro", "Gemini"] } });
  });

  it("shows update error in footer when update.error is present", () => {
    const page = setupWithRail();
    page.doc.getElementById(RAIL_ENTRY_ID)!.click();
    page.push([], {
      buildId: "51f19c9",
      update: { checkedAt: "2026-11-21T09:59:00.000Z", error: "打包出错" },
    });
    const footer = page.doc.getElementById(PANEL_ID)!.querySelector("footer")!;
    expect(footer.className).toBe("bad");
    expect(footer.textContent).toContain("更新失败：打包出错");
    expect(footer.textContent).toContain("51f19c9");
    expect(footer.textContent).toContain("~/Library/Logs/codexhost-ui-plugins");
  });
});

describe("rail entry, toast, and pet isolation (C2.2)", () => {
  it("mounts rail entry above '!', survives React re-render removal, and toggles panel", () => {
    const page = setupWithRail();
    const entry = page.doc.getElementById(RAIL_ENTRY_ID)!;
    const panel = page.doc.getElementById(PANEL_ID)!;

    expect(entry.parentNode).toBe(page.nav);
    expect(entry.nextSibling).toBe(page.bang);

    // Toggle open by clicking rail entry
    entry.click();
    expect(panel.hidden).toBe(false);
    expect(entry.classList.contains("active")).toBe(true);

    // Close with Escape
    page.doc.dispatchEvent({ type: "keydown", key: "Escape" });
    expect(panel.hidden).toBe(true);
    expect(entry.classList.contains("active")).toBe(false);

    // Simulate React re-render removing the rail entry button
    entry.remove();
    expect(entry.parentNode).toBe(page.nav);
    expect(entry.nextSibling).toBe(page.bang);
  });

  it("mounts above Usage in Desktop's narrow App navigation rail and ignores thread rows in Home nav", () => {
    const page = fakeWindow("main");
    activeDoc = page.doc;

    const rail = page.doc.createElement("nav");
    rail.setAttribute("aria-label", "App navigation");
    rail.setRect({ left: 0, width: 68, top: 0, height: 800, right: 68, bottom: 800 });
    const usage = page.doc.createElement("button");
    usage.setAttribute("aria-label", "Usage");
    const avatar = page.doc.createElement("button");
    avatar.setAttribute("aria-label", "Account");
    rail.append(usage, avatar);

    const homeNav = page.doc.createElement("nav");
    homeNav.setAttribute("aria-label", "Home");
    homeNav.setRect({ left: 68, width: 260, top: 0, height: 800, right: 328, bottom: 800 });
    const threadRow = page.doc.createElement("button");
    threadRow.setAttribute("aria-label", "排查一个奇怪的问题");
    homeNav.append(threadRow);

    page.doc.body.append(rail, homeNav);
    startLoader(page.win, "51f19c9");

    const entry = page.doc.getElementById(RAIL_ENTRY_ID)!;
    expect(entry.parentNode).toBe(rail);
    expect(entry.nextSibling).toBe(usage);
  });

  it("throttles fallback anchor lookups during DOM mutations and attaches once the narrow rail appears", () => {
    const page = fakeWindow("main");
    activeDoc = page.doc;
    startLoader(page.win, "51f19c9");

    const entry = page.doc.getElementById(RAIL_ENTRY_ID)!;
    expect(entry.classList.contains("cxp-plug-fallback")).toBe(true);

    // Wide Home nav should not steal the entry even with matching text.
    const homeNav = page.doc.createElement("nav");
    homeNav.setAttribute("aria-label", "Home");
    homeNav.setRect({ left: 68, width: 260, top: 0, height: 800, right: 328, bottom: 800 });
    const issueBtn = page.doc.createElement("button");
    issueBtn.setAttribute("aria-label", "问题反馈");
    homeNav.append(issueBtn);
    page.doc.body.append(homeNav);
    vi.advanceTimersByTime(300);
    expect(entry.classList.contains("cxp-plug-fallback")).toBe(true);

    // Narrow rail appears -> throttled timer moves entry above the last button.
    const rail = page.doc.createElement("nav");
    rail.setRect({ left: 0, width: 68, top: 0, height: 800, right: 68, bottom: 800 });
    const b1 = page.doc.createElement("button");
    const b2 = page.doc.createElement("button");
    rail.append(b1, b2);
    page.doc.body.append(rail);
    expect(entry.classList.contains("cxp-plug-fallback")).toBe(true); // throttled, not sync
    vi.advanceTimersByTime(250);
    expect(entry.classList.contains("cxp-plug-fallback")).toBe(false);
    expect(entry.parentNode).toBe(rail);
    expect(entry.nextSibling).toBe(b2);
  });

  it("lifts past nested row wrappers into the flex-col bottom container above the empty Usage slot", () => {
    const page = fakeWindow("main");
    activeDoc = page.doc;

    const rail = page.doc.createElement("nav");
    rail.setAttribute("aria-label", "App navigation");
    rail.setRect({ left: 0, width: 68, top: 0, height: 1040, right: 68, bottom: 1040 });

    const topGroup = page.doc.createElement("div");
    const topSettings = page.doc.createElement("button");
    topSettings.setAttribute("aria-label", "打开 codexhost 设置");
    topGroup.append(topSettings);

    const bottomShell = page.doc.createElement("div");
    bottomShell.className = "relative shrink-0 w-9";
    const flexCol = page.doc.createElement("div");
    flexCol.className = "flex items-center flex-col gap-2";
    const usageSlot = page.doc.createElement("div");
    usageSlot.className = "flex items-center empty:hidden flex-col gap-2";
    const rowOuter = page.doc.createElement("div");
    rowOuter.className = "flex w-full";
    const rowMid = page.doc.createElement("div");
    rowMid.className = "flex sidebar-item justify-center";
    const rowInner = page.doc.createElement("div");
    rowInner.className = "flex min-w-0 flex-1 justify-center";
    const profileBtn = page.doc.createElement("button");
    profileBtn.setAttribute("aria-label", "Open profile menu");
    rowInner.append(profileBtn);
    rowMid.append(rowInner);
    rowOuter.append(rowMid);
    flexCol.append(usageSlot, rowOuter);
    bottomShell.append(flexCol);

    rail.append(topGroup, bottomShell);
    page.doc.body.append(rail);
    startLoader(page.win, "51f19c9");

    const entry = page.doc.getElementById(RAIL_ENTRY_ID)!;
    expect(entry.parentNode).toBe(flexCol);
    expect(entry.nextSibling).toBe(usageSlot);

    // Re-running ensureMounted / React re-render remains idempotent above usageSlot.
    entry.remove();
    expect(entry.parentNode).toBe(flexCol);
    expect(entry.nextSibling).toBe(usageSlot);
  });

  it("updates red dot and shows toast once per (plugin, reason) per page load", () => {
    const page = setupWithRail();
    const entry = page.doc.getElementById(RAIL_ENTRY_ID)!;
    const dot = entry.querySelector(".cxp-dot")!;
    const toast = page.doc.getElementById(TOAST_ID)!;
    const panel = page.doc.getElementById(PANEL_ID)!;

    expect(dot.hidden).toBe(true);
    expect(toast.hidden).toBe(true);

    // Transition to failed -> dot on, toast shown
    page.push([{ id: "pet", name: "Pet", status: "failed", source: "rewriter", reason: "chunk not found" }]);
    expect(dot.hidden).toBe(false);
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toContain("插件「Pet」已停用：chunk not found");

    // Click "查看" -> opens panel and hides toast
    toast.querySelector(".cxp-toast-view")!.click();
    expect(panel.hidden).toBe(false);
    expect(toast.hidden).toBe(true);

    // Repeated state push with same (id, reason) -> does NOT show toast again
    page.push([{ id: "pet", name: "Pet", status: "failed", source: "rewriter", reason: "chunk not found" }]);
    expect(toast.hidden).toBe(true);
    expect(dot.hidden).toBe(false);

    // Different reason for same plugin -> DOES show toast
    page.push([{ id: "pet", name: "Pet", status: "failed", source: "rewriter", reason: "new error" }]);
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toContain("插件「Pet」已停用：new error");

    // Manual close button hides toast
    toast.querySelector(".cxp-toast-close")!.click();
    expect(toast.hidden).toBe(true);

    // Recovery clears red dot
    page.push([{ id: "pet", name: "Pet", status: "active" }]);
    expect(dot.hidden).toBe(true);
  });

  it("does not mount UI or styles in the pet window", () => {
    const page = setupWithRail("pet");
    page.push([{ id: "pet", name: "Pet", status: "failed", source: "rewriter", reason: "boom" }]);
    expect(page.doc.getElementById(STYLE_ID)).toBeNull();
    expect(page.doc.getElementById(RAIL_ENTRY_ID)).toBeNull();
    expect(page.doc.getElementById(PANEL_ID)).toBeNull();
    expect(page.doc.getElementById(TOAST_ID)).toBeNull();
  });
});

describe("theme styles (C2.3)", () => {
  it("injects light and dark theme variables matching the mockup", () => {
    const page = setupWithRail();
    const style = page.doc.getElementById(STYLE_ID);
    expect(style).not.toBeNull();
    expect(style?.textContent).toBe(UI_CSS);
    // Light tokens
    expect(UI_CSS).toContain("--cxp-bg: #f7f6f2");
    expect(UI_CSS).toContain("--cxp-panel: #fff");
    expect(UI_CSS).toContain("--cxp-bad: #b42318");
    // Dark tokens (explicit attribute/class + system prefers-color-scheme)
    expect(UI_CSS).toContain('[data-theme="dark"]');
    expect(UI_CSS).toContain(":root.dark");
    expect(UI_CSS).toContain("prefers-color-scheme: dark");
    expect(UI_CSS).toContain("--cxp-bg: #1e1e1d");
    expect(UI_CSS).toContain("--cxp-panel: #2a2a29");
    expect(UI_CSS).toContain("--cxp-bad: #ff7a6b");
  });
});
