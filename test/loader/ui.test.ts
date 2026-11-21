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
  it("handles null daemon state before first push, then lists all plugins and statuses", () => {
    const page = setupWithRail();
    const panel = page.doc.getElementById(PANEL_ID)!;
    expect(panel).not.toBeNull();
    expect(panel.hidden).toBe(true);
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

    // text
    const textInput = panel.querySelector('[data-cxp-field="demo:dir"]')!;
    expect(textInput.value).toBe("~/Developer");
    textInput.value = "~/Work";
    textInput.dispatchEvent({ type: "change" });
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
