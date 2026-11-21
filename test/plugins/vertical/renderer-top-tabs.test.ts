import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as topTabs from "../../../plugins/vertical/top-tabs/index.ts";
import {
  FakeDocument,
  FakeElement,
  FakeWindow,
  installFakeMutationObserver,
} from "./fake-dom.ts";

interface RowSpec {
  readonly id: string;
  readonly indicator?: string;
  readonly selected?: boolean;
  readonly hostId?: string;
  readonly title?: string;
}

let restoreObserver: (() => void) | null = null;
const handles: topTabs.RendererTopTabsHandle[] = [];

beforeEach(() => {
  restoreObserver = installFakeMutationObserver();
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose();
  restoreObserver?.();
  restoreObserver = null;
});

function createRowElement(doc: FakeDocument, spec: RowSpec): FakeElement {
  const hostId = spec.hostId ?? "local";
  const row = doc.createElement("div");
  row.setAttribute("data-app-action-sidebar-thread-row", "true");
  row.setAttribute("data-app-action-sidebar-thread-id", `${hostId}:${spec.id}`);
  row.setAttribute("data-app-action-sidebar-thread-host-id", hostId);
  row.setAttribute("data-app-action-sidebar-thread-title", spec.title ?? `Title ${spec.id}`);
  if (spec.indicator) row.setAttribute("data-sidebar-indicator", spec.indicator);
  if (spec.selected) row.setAttribute("data-app-action-sidebar-thread-selected", "true");
  return row;
}

function setup(rows: RowSpec[], options: topTabs.InstallRendererTopTabsOptions = {}) {
  const doc = new FakeDocument();
  const win = new FakeWindow(doc, 1280);

  const nav = doc.createElement("nav");
  const scroll = doc.createElement("div");
  scroll.setAttribute("data-app-action-sidebar-scroll", "");
  for (const spec of rows) scroll.appendChild(createRowElement(doc, spec));
  nav.appendChild(scroll);

  const activePage = doc.createElement("div");
  activePage.setAttribute("data-app-shell-active-page", "true");
  const main = doc.createElement("main");
  main.setAttribute("data-app-shell-main-surface", "default");
  const page = doc.createElement("div");
  page.className = "page";
  main.appendChild(page);
  activePage.appendChild(main);

  doc.body.append(nav, activePage);

  const handle = topTabs.installRendererTopTabs({
    document: doc as unknown as Document,
    window: win as unknown as Window,
    ...options,
  });
  handles.push(handle);

  const find = (selector: string): FakeElement => {
    const el = doc.querySelector(selector);
    if (!el) throw new Error(`missing ${selector}`);
    return el;
  };
  const row = (id: string, hostId = "local") =>
    find(`[data-app-action-sidebar-thread-id="${hostId}:${id}"]`);
  const tabs = () =>
    doc
      .querySelectorAll(`[${topTabs.TOP_TAB_ATTRIBUTE}]`)
      .map((tab) => tab.getAttribute(topTabs.TOP_TAB_ATTRIBUTE));
  const strip = () => doc.querySelector(`[${topTabs.TOP_TABS_ROOT_ATTRIBUTE}]`);

  return { doc, win, nav, scroll, activePage, page, handle, find, row, tabs, strip };
}

/** Mutations are coalesced on a short timer. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("collectSidebarThreads", () => {
  it("reads status, title and selection from native sidebar attributes", () => {
    const { doc } = setup([
      { id: "a", indicator: "working", selected: true },
      { id: "b", indicator: "approval" },
      { id: "c", indicator: "input" },
      { id: "d", indicator: "error" },
      { id: "e", indicator: "unread" },
      { id: "f" },
    ]);
    const map = topTabs.collectSidebarThreads(doc as unknown as Document);
    expect([...map.values()].map((s) => [s.threadId, s.status, s.active, s.title])).toEqual([
      ["a", "running", true, "Title a"],
      ["b", "waiting", false, "Title b"],
      ["c", "waiting", false, "Title c"],
      ["d", "failed", false, "Title d"],
      ["e", "unread", false, "Title e"],
      ["f", "idle", false, "Title f"],
    ]);
  });

  it("skips codexhost mirror rows and unsent drafts", () => {
    const { doc, scroll } = setup([{ id: "a", indicator: "working" }]);
    scroll.appendChild(createRowElement(doc, { id: "client-new-thread:x", indicator: "working" }));
    const mirror = createRowElement(doc, { id: "a", indicator: "working" });
    mirror.setAttribute("data-codexhost-sidebar-thread-mirror", "true");
    scroll.appendChild(mirror);
    expect([...topTabs.collectSidebarThreads(doc as unknown as Document).keys()]).toEqual([
      "local:a",
    ]);
  });
});

describe("installRendererTopTabs", () => {
  it("lists only sessions that need attention, inside the main surface", () => {
    const { tabs, strip } = setup([
      { id: "run", indicator: "working" },
      { id: "idle" },
      { id: "open", selected: true },
      { id: "done", indicator: "unread", hostId: "remote-ssh-discovered:mac-work" },
    ]);
    expect(strip()?.parentElement?.tagName).toBe("MAIN");
    expect(strip()?.parentElement?.firstElementChild).toBe(strip());
    expect(tabs()).toEqual(["local:run", "remote-ssh-discovered:mac-work:done"]);
  });

  it("marks each status with a colored dot and opens the thread through its native row", () => {
    const { doc, row, find } = setup([
      { id: "run", indicator: "working" },
      { id: "ask", indicator: "input" },
      { id: "done", indicator: "unread" },
      { id: "err", indicator: "error" },
    ]);
    const dots = doc
      .querySelectorAll(`[${topTabs.TOP_TAB_ATTRIBUTE}]`)
      .map((tab) => tab.querySelector(".codexhost-session-tab-status")?.getAttribute("data-status"));
    expect(dots).toEqual(["running", "waiting", "unread", "failed"]);
    const tab = find(`[${topTabs.TOP_TAB_ATTRIBUTE}="local:run"]`);
    expect(tab.title).toBe("Title run · Running");
    const click = vi.fn();
    row("run").addEventListener("click", click);
    tab.click();
    expect(click).toHaveBeenCalledOnce();
  });

  it("keeps a thread opened from the strip until the user leaves it", async () => {
    const { row, tabs } = setup([{ id: "a", indicator: "unread", selected: true }, { id: "b" }]);
    row("a").removeAttribute("data-sidebar-indicator");
    await settle();
    expect(tabs()).toEqual(["local:a"]);
    row("a").removeAttribute("data-app-action-sidebar-thread-selected");
    row("b").setAttribute("data-app-action-sidebar-thread-selected", "true");
    await settle();
    expect(tabs()).toEqual([]);
  });

  it("acknowledges a failed thread once viewed and shows it again when it fails after running", async () => {
    const { row, tabs } = setup([
      { id: "a", indicator: "error" },
      { id: "b", selected: true },
    ]);
    expect(tabs()).toEqual(["local:a"]);
    row("b").removeAttribute("data-app-action-sidebar-thread-selected");
    row("a").setAttribute("data-app-action-sidebar-thread-selected", "true");
    await settle();
    row("a").removeAttribute("data-app-action-sidebar-thread-selected");
    row("b").setAttribute("data-app-action-sidebar-thread-selected", "true");
    await settle();
    expect(tabs()).toEqual([]);
    row("a").setAttribute("data-sidebar-indicator", "working");
    await settle();
    row("a").setAttribute("data-sidebar-indicator", "error");
    await settle();
    expect(tabs()).toEqual(["local:a"]);
  });

  it("hides when nothing needs attention or the preference is off", async () => {
    const { win, row, strip } = setup([{ id: "a", indicator: "working" }]);
    expect(strip()?.hidden).toBe(false);
    row("a").removeAttribute("data-sidebar-indicator");
    await settle();
    expect(strip()?.hidden).toBe(true);
    row("a").setAttribute("data-sidebar-indicator", "working");
    await settle();
    expect(strip()?.hidden).toBe(false);
    topTabs.writeTopTabsEnabledPreference(false, win as unknown as Window);
    await settle();
    expect(strip()?.hidden).toBe(true);
  });

  it("groups child threads under their root and rolls up the most urgent status", () => {
    const { doc, tabs } = setup([{ id: "root" }, { id: "child", indicator: "approval" }], {
      tree: { rootThread: (_host: string, id: string) => (id === "child" ? "root" : id) },
    });
    expect(tabs()).toEqual(["local:root"]);
    const tab = doc.querySelector(`[${topTabs.TOP_TAB_ATTRIBUTE}="local:root"]`);
    expect(tab?.getAttribute("data-status")).toBe("waiting");
  });

  it("reports changes on the first collection and whenever the session set changes", async () => {
    const onChange = vi.fn();
    const { row, handle } = setup([{ id: "a" }], { onChange });
    expect(onChange).toHaveBeenCalledTimes(1);
    row("a").setAttribute("data-app-action-sidebar-thread-title", "Renamed");
    await settle();
    expect(onChange).toHaveBeenCalledTimes(2);
    handle.refresh();
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("ignores transcript mutations outside the sidebar", async () => {
    const onChange = vi.fn();
    const { doc, page } = setup([{ id: "a", indicator: "working" }], { onChange });
    page.appendChild(doc.createElement("p"));
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("mounts on the page on screen when Codex keeps hidden pages mounted", () => {
    const { doc, activePage, handle } = setup([{ id: "a", indicator: "working" }]);
    const hiddenPage = doc.createElement("div");
    hiddenPage.setAttribute("data-app-shell-active-page", "false");
    const hiddenMain = doc.createElement("main");
    hiddenMain.setAttribute("data-app-shell-main-surface", "default");
    hiddenPage.appendChild(hiddenMain);
    doc.body.insertBefore(hiddenPage, activePage);
    handle.refresh();
    expect(
      doc
        .querySelector(`[${topTabs.TOP_TABS_ROOT_ATTRIBUTE}]`)
        ?.closest("[data-app-shell-active-page]")
        ?.getAttribute("data-app-shell-active-page"),
    ).toBe("true");
  });

  it("marks remote tabs with their host's globe color from the sidebar project icon", () => {
    const { doc, scroll, strip, handle } = setup([
      { id: "r", indicator: "working", hostId: "remote-ssh:mac" },
    ]);
    const holder = doc.createElement("span");
    holder.setAttribute("data-sidebar-project-kind", "remote");
    const svg = doc.createElement("svg");
    svg.setAttribute("style", "--remote-host-globe-color: #ffc300");
    Object.defineProperty(svg, "__reactFiber$test", {
      value: {
        memoizedProps: { style: {} },
        return: { memoizedProps: { hostId: "remote-ssh:mac" } },
      },
    });
    holder.appendChild(svg);
    scroll.appendChild(holder);
    handle.refresh();
    expect(strip()?.querySelector(".codexhost-session-tab-host path")?.getAttribute("fill")).toBe(
      "#ffc300",
    );
  });

  it("wraps into two rows of five and collapses the rest into a +N menu", async () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({
      id: `t${i}`,
      indicator: "working",
      selected: i === 12,
    }));
    const { doc, win, find, tabs } = setup(rows);
    expect(tabs()).toHaveLength(9);
    expect(tabs()[8]).toBe("local:t12");
    const more = find(`[${topTabs.TOP_TABS_MORE_ATTRIBUTE}]`);
    expect(more.textContent).toBe("+4");
    more.click();
    const menuItems = doc
      .querySelectorAll(`[${topTabs.TOP_TABS_MENU_ATTRIBUTE}] [role="menuitem"]`)
      .map((item) => item.getAttribute(topTabs.TOP_TAB_ATTRIBUTE));
    expect(menuItems).toEqual(["local:t8", "local:t9", "local:t10", "local:t11"]);
    doc.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(doc.querySelector(`[${topTabs.TOP_TABS_MENU_ATTRIBUTE}]`)).toBeNull();

    topTabs.setTopTabsTwoRowsPreference(win as unknown as Window, false);
    await settle();
    expect(tabs()).toHaveLength(4);
    expect(find(`[${topTabs.TOP_TABS_MORE_ATTRIBUTE}]`).textContent).toBe("+9");
  });

  it("removes injected strip and styles on dispose", () => {
    const { doc, handle } = setup([{ id: "a", indicator: "working" }]);
    expect(doc.querySelector(`[${topTabs.TOP_TABS_ROOT_ATTRIBUTE}]`)).not.toBeNull();
    expect(doc.getElementById(topTabs.TOP_TABS_STYLE_ID)).not.toBeNull();
    handle.dispose();
    expect(doc.querySelector(`[${topTabs.TOP_TABS_ROOT_ATTRIBUTE}]`)).toBeNull();
    expect(doc.getElementById(topTabs.TOP_TABS_STYLE_ID)).toBeNull();
  });
});

describe("resolveShortHostLabel", () => {
  it("shortens remote host ids and custom names", () => {
    expect(topTabs.resolveShortHostLabel("local")).toBeNull();
    expect(topTabs.resolveShortHostLabel("remote-ssh-discovered:mac-work")).toBe("mac-work");
    expect(topTabs.resolveShortHostLabel("h1", "yuwk@macpro.local:22")).toBe("MacPro");
    expect(topTabs.resolveShortHostLabel("h2", "192.168.1.20:22")).toBe("192.168.1.20");
  });
});
