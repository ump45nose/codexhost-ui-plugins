import { afterEach, describe, expect, it, vi } from "vitest";

import manifest from "../../../plugins/stash/plugin.ts";
import {
  installSidebarStash,
  STASH_GLOBAL_KEY,
  type CxpStashV1,
} from "../../../plugins/stash/install.ts";
import { listReservedHotkeys } from "../../../plugins/stash/reserved-hotkeys.ts";
import { STORAGE_KEY } from "../../../plugins/stash/storage.ts";
import { STYLE_ATTR } from "../../../plugins/stash/style.ts";

/** Minimal in-memory DOM stand-in for Node vitest (no jsdom dependency). */
class FakeNode extends EventTarget {
  readonly nodeType = 1;
  parentElement: FakeNode | null = null;
  children: FakeNode[] = [];
  attributes = new Map<string, string>();
  style: Record<string, string> = {};
  textContent = "";
  hidden = false;
  isConnected = false;
  tagName: string;
  ownerDocument: FakeDocument | null = null;
  className = "";
  type = "";
  value = "";
  disabled = false;
  isContentEditable = false;
  offsetWidth = 220;
  offsetHeight = 200;

  constructor(tag = "div") {
    super();
    this.tagName = tag.toUpperCase();
  }

  get parentNode(): FakeNode | null {
    return this.parentElement;
  }

  get nextSibling(): FakeNode | null {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    return idx >= 0 ? (this.parentElement.children[idx + 1] ?? null) : null;
  }

  get previousElementSibling(): FakeNode | null {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    return idx > 0 ? (this.parentElement.children[idx - 1] ?? null) : null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === "contenteditable" && value === "true") this.isContentEditable = true;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  getAttributeNames(): string[] {
    return [...this.attributes.keys()];
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  private attach(node: FakeNode): void {
    node.remove();
    node.parentElement = this;
    node.isConnected = this.isConnected;
    node.ownerDocument = this.ownerDocument;
  }

  appendChild(node: FakeNode): FakeNode {
    this.attach(node);
    this.children.push(node);
    return node;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    this.attach(node);
    if (!ref) {
      this.children.push(node);
      return node;
    }
    const idx = this.children.indexOf(ref);
    if (idx < 0) this.children.push(node);
    else this.children.splice(idx, 0, node);
    return node;
  }

  after(...nodes: FakeNode[]): void {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    let index = parent.children.indexOf(this);
    for (const node of nodes) {
      node.remove();
      node.parentElement = parent;
      node.isConnected = parent.isConnected;
      node.ownerDocument = parent.ownerDocument;
      index += 1;
      parent.children.splice(index, 0, node);
    }
  }

  replaceChildren(...nodes: FakeNode[]): void {
    for (const child of this.children) {
      child.parentElement = null;
      child.isConnected = false;
    }
    this.children = [];
    this.append(...nodes);
  }

  remove(): void {
    if (!this.parentElement) return;
    const idx = this.parentElement.children.indexOf(this);
    if (idx >= 0) this.parentElement.children.splice(idx, 1);
    this.parentElement = null;
    this.isConnected = false;
  }

  contains(other: FakeNode | null): boolean {
    let cur: FakeNode | null = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  matches(selector: string): boolean {
    return selector
      .split(",")
      .map((s) => s.trim())
      .some((part) => matchesSimple(this, part));
  }

  closest(selector: string): FakeNode | null {
    let cur: FakeNode | null = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (node: FakeNode): void => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  click(): void {
    this.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
  }

  focus(): void {}

  getBoundingClientRect(): DOMRect {
    return {
      x: 40,
      y: 60,
      top: 60,
      left: 40,
      bottom: 84,
      right: 160,
      width: 120,
      height: 24,
      toJSON() {
        return this;
      },
    } as DOMRect;
  }
}

function matchesSimple(node: FakeNode, selector: string): boolean {
  let rest = selector.trim();
  if (!rest) return false;
  // Support descendant combinator like `[data-pip-obstacle="..."] aside`
  const parts = rest.split(/\s+/);
  if (parts.length > 1) {
    const last = parts[parts.length - 1]!;
    if (!matchesSimple(node, last)) return false;
    let cur = node.parentElement;
    const ancestorSel = parts.slice(0, -1).join(" ");
    while (cur) {
      if (matchesSimple(cur, ancestorSel)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // Extract attribute selectors: [attr] or [attr="val"]
  const attrRegex = /\[([^\]=]+)(?:="([^"]*)")?\]/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(rest)) !== null) {
    const attrName = match[1]!;
    const attrVal = match[2];
    if (attrVal === undefined) {
      if (!node.hasAttribute(attrName)) return false;
    } else if (node.getAttribute(attrName) !== attrVal) {
      return false;
    }
  }
  const withoutAttrs = rest.replace(attrRegex, "");
  if (!withoutAttrs) return true;
  const [tagPart, ...classParts] = withoutAttrs.split(".");
  if (tagPart && node.tagName.toLowerCase() !== tagPart.toLowerCase()) return false;
  for (const cls of classParts) {
    if (!node.className.split(/\s+/).includes(cls)) return false;
  }
  return true;
}

class FakeDocument {
  documentElement = new FakeNode("html");
  head = new FakeNode("head");
  body = new FakeNode("body");
  defaultView: FakeWindow | null = null;
  private listeners: Array<{
    type: string;
    listener: EventListenerOrEventListenerObject;
    capture: boolean;
  }> = [];

  constructor() {
    this.documentElement.isConnected = true;
    this.documentElement.ownerDocument = this;
    this.head.isConnected = true;
    this.body.isConnected = true;
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  private normalizeCapture(options?: boolean | AddEventListenerOptions): boolean {
    return typeof options === "boolean" ? options : Boolean(options?.capture);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const capture = this.normalizeCapture(options);
    if (
      !this.listeners.some(
        (entry) => entry.type === type && entry.listener === listener && entry.capture === capture,
      )
    ) {
      this.listeners.push({ type, listener, capture });
    }
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    const capture = this.normalizeCapture(options);
    const idx = this.listeners.findIndex(
      (entry) => entry.type === type && entry.listener === listener && entry.capture === capture,
    );
    if (idx >= 0) this.listeners.splice(idx, 1);
  }

  dispatchEvent(event: Event): boolean {
    for (const entry of [...this.listeners]) {
      if (entry.type !== event.type) continue;
      if (typeof entry.listener === "function") entry.listener(event);
      else entry.listener.handleEvent(event);
    }
    return !event.defaultPrevented;
  }

  get listenerCount(): number {
    return this.listeners.length;
  }

  createElement(tag: string): FakeNode {
    const node = new FakeNode(tag);
    node.ownerDocument = this;
    return node;
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.documentElement.querySelectorAll(selector);
  }

  querySelector(selector: string): FakeNode | null {
    return this.documentElement.querySelector(selector);
  }
}

class FakeWindow extends EventTarget {
  innerWidth = 1280;
  innerHeight = 800;
  [key: string]: unknown;
}

function createMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

function buildDesktopFixture(activeThreadId = "thread-active-01") {
  const doc = new FakeDocument();
  const win = new FakeWindow();
  doc.defaultView = win;

  const aside = doc.createElement("aside");
  aside.className = "app-shell-left-panel";
  const scroll = doc.createElement("div");
  scroll.setAttribute("data-app-action-sidebar-scroll", "1");

  const pinnedSection = doc.createElement("section");
  pinnedSection.setAttribute("data-app-action-sidebar-section", "pinned");

  const recentSection = doc.createElement("section");
  recentSection.setAttribute("data-app-action-sidebar-section", "recent");

  const threadBtn = doc.createElement("button");
  threadBtn.setAttribute("data-app-action-sidebar-thread-id", activeThreadId);
  threadBtn.setAttribute("aria-current", "page");
  const titleSpan = doc.createElement("span");
  titleSpan.setAttribute("data-app-action-sidebar-thread-title", "1");
  titleSpan.textContent = "Active Thread";
  threadBtn.appendChild(titleSpan);
  recentSection.appendChild(threadBtn);

  const projectsSection = doc.createElement("section");
  projectsSection.setAttribute("data-app-action-sidebar-section", "projects");

  scroll.append(pinnedSection, recentSection, projectsSection);
  aside.appendChild(scroll);

  // Composer fixture
  const composer = doc.createElement("div");
  composer.setAttribute("data-codex-composer-root", "1");
  const form = doc.createElement("form");
  const editor = doc.createElement("textarea");
  editor.value = "Hello world";
  const sendBtn = doc.createElement("button");
  sendBtn.type = "submit";
  sendBtn.setAttribute("aria-label", "Send");
  form.append(editor, sendBtn);
  composer.appendChild(form);

  doc.body.append(aside, composer);

  return { doc, win, scroll, pinnedSection, recentSection, projectsSection, threadBtn, composer, form, editor, sendBtn };
}

function dispatchDocEvent(
  doc: FakeDocument,
  type: string,
  target: FakeNode,
  props: Record<string, unknown> = {},
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { value: target, configurable: true });
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(event, k, { value: v, configurable: true });
  }
  doc.dispatchEvent(event);
  return event;
}

afterEach(() => {
  delete (globalThis as { __codexHostReservedHotkeys?: unknown }).__codexHostReservedHotkeys;
});

describe("plugins/stash manifest", () => {
  it("declares expected id, window, page entry, and forkGuard", () => {
    expect(manifest.id).toBe("stash");
    expect(manifest.name).toBe("收纳箱");
    expect(manifest.windows).toEqual(["main"]);
    expect(manifest.page).toBe("./page.ts");
    expect(manifest.forkGuards).toEqual(["__codexhostSidebarStashV1"]);
  });
});

describe("stash mount, persistence compatibility, and cleanup (C2.4)", () => {
  it("mounts after Recents, reads existing codexhost.sidebar-stash.v1 data, and persists updates", () => {
    const existingPayload = {
      version: 1,
      updatedAt: "2026-11-18T10:00:00.000Z",
      items: {
        "old-fork-thread-1": {
          title: "Fork Stashed Thread",
          dueAt: null,
          stashedAt: "2026-11-18T10:00:00.000Z",
        },
      },
    };
    const storage = createMemoryStorage({
      [STORAGE_KEY]: JSON.stringify(existingPayload),
    });
    const { doc, win, scroll, recentSection } = buildDesktopFixture();

    const handle = installSidebarStash({
      document: doc as unknown as Document,
      window: win as unknown as Window & typeof globalThis,
      storage,
      getLocale: () => "zh-CN",
    });
    expect(handle).not.toBeNull();

    // Mounted immediately after Recents inside the scroll container.
    const stashRoot = doc.querySelector("[data-codexhost-sidebar-stash-root]");
    expect(stashRoot).not.toBeNull();
    expect(stashRoot?.parentElement).toBe(scroll);
    expect(stashRoot?.previousElementSibling).toBe(recentSection);

    // Existing fork data is loaded and rendered.
    expect(handle!.store.has("old-fork-thread-1")).toBe(true);
    const rows = doc.querySelectorAll("[data-codexhost-sidebar-stash-row]");
    expect(rows.length).toBe(1);
    expect(rows[0]?.getAttribute("data-thread-id")).toBe("old-fork-thread-1");

    // Stashing a new item persists to codexhost.sidebar-stash.v1 and survives reload.
    handle!.stashThread({ threadId: "new-thread-0002", title: "New Thread" });
    const saved = JSON.parse(storage.map.get(STORAGE_KEY)!) as { items: Record<string, { title: string }> };
    expect(saved.items["old-fork-thread-1"]?.title).toBe("Fork Stashed Thread");
    expect(saved.items["new-thread-0002"]?.title).toBe("New Thread");

    handle!.dispose();

    // Re-installing (simulating page reload / Desktop restart) preserves both items.
    const handle2 = installSidebarStash({
      document: doc as unknown as Document,
      window: win as unknown as Window & typeof globalThis,
      storage,
      getLocale: () => "zh-CN",
    });
    expect(handle2!.store.has("old-fork-thread-1")).toBe(true);
    expect(handle2!.store.has("new-thread-0002")).toBe(true);
    handle2!.dispose();
  });

  it("never sets fork guards or __codexStash_v1, and cleans up DOM, styles, listeners, hotkeys, and __cxpStashV1 on dispose", () => {
    const storage = createMemoryStorage();
    const { doc, win, editor, sendBtn } = buildDesktopFixture("thread-active-01");

    const handle = installSidebarStash({
      document: doc as unknown as Document,
      window: win as unknown as Window & typeof globalThis,
      storage,
      getLocale: () => "zh-CN",
    })!;

    expect(win.__codexStash_v1).toBeUndefined();
    expect(win.__codexhostSidebarStashV1).toBeUndefined();
    expect(win[STASH_GLOBAL_KEY]).toBeDefined();
    expect(doc.head.querySelector(`[${STYLE_ATTR}]`)).not.toBeNull();
    expect(listReservedHotkeys().length).toBe(3);

    // Open a due popover so we also verify dispose closes open popovers.
    const api = win[STASH_GLOBAL_KEY] as CxpStashV1;
    api.setRestoreDate(
      { threadId: "thread-active-01", title: "Active Thread", hostId: "local" },
      sendBtn as unknown as HTMLElement,
    );
    expect(doc.querySelector("[data-codexhost-sidebar-stash-popover]")).not.toBeNull();

    handle.dispose();

    expect(doc.querySelector("[data-codexhost-sidebar-stash-root]")).toBeNull();
    expect(doc.querySelector("[data-codexhost-sidebar-stash-popover]")).toBeNull();
    expect(doc.head.querySelector(`[${STYLE_ATTR}]`)).toBeNull();
    expect(win[STASH_GLOBAL_KEY]).toBeUndefined();
    expect(api.available()).toBe(false);
    expect(listReservedHotkeys().length).toBe(0);
    expect(doc.listenerCount).toBe(0);

    // Listeners were removed: Enter in composer after dispose does not throw or mutate state.
    dispatchDocEvent(doc, "keydown", editor, { key: "Enter", code: "Enter" });
    expect(handle.store.has("thread-active-01")).toBe(true);
  });
});

describe("window.__cxpStashV1 contract", () => {
  it("exposes available, isStashed, stash, unstash, setRestoreDate, subscribe", () => {
    const storage = createMemoryStorage();
    const { doc, win, sendBtn } = buildDesktopFixture();
    const handle = installSidebarStash({
      document: doc as unknown as Document,
      window: win as unknown as Window & typeof globalThis,
      storage,
      getLocale: () => "zh-CN",
    })!;

    const api = win[STASH_GLOBAL_KEY] as CxpStashV1;
    expect(api.available()).toBe(true);
    expect(api.isStashed("remote-thread-99")).toBe(false);

    const listener = vi.fn();
    const unsub = api.subscribe(listener);

    api.stash({ hostId: "nas", threadId: "remote-thread-99", title: "Remote Task" });
    expect(api.isStashed("remote-thread-99")).toBe(true);
    expect(handle.store.get("remote-thread-99")?.hostId).toBe("nas");
    expect(listener).toHaveBeenCalledTimes(1);

    api.setRestoreDate(
      { hostId: "nas", threadId: "remote-thread-99", title: "Remote Task" },
      sendBtn as unknown as HTMLElement,
    );
    const popover = doc.querySelector("[data-codexhost-sidebar-stash-popover]");
    expect(popover).not.toBeNull();

    api.unstash("remote-thread-99");
    expect(api.isStashed("remote-thread-99")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
    api.stash({ hostId: "nas", threadId: "remote-thread-99", title: "Again" });
    expect(listener).toHaveBeenCalledTimes(2);

    handle.dispose();
  });
});

describe("auto-unstash on user message without internal events (C2.5)", () => {
  it("unstashes the active thread on Enter in the composer editor", () => {
    const storage = createMemoryStorage();
    const { doc, win, editor } = buildDesktopFixture("thread-active-01");
    const handle = installSidebarStash({
      document: doc as unknown as Document,
      window: win as unknown as Window & typeof globalThis,
      storage,
    })!;

    handle.stashThread({ threadId: "thread-active-01", title: "Active Thread" });
    expect(handle.store.has("thread-active-01")).toBe(true);

    // Shift+Enter (newline) must NOT unstash.
    dispatchDocEvent(doc, "keydown", editor, { key: "Enter", code: "Enter", shiftKey: true });
    expect(handle.store.has("thread-active-01")).toBe(true);

    // IME composing Enter must NOT unstash.
    dispatchDocEvent(doc, "keydown", editor, { key: "Enter", code: "Enter", isComposing: true });
    expect(handle.store.has("thread-active-01")).toBe(true);

    // Plain Enter in composer editor DOES unstash.
    dispatchDocEvent(doc, "keydown", editor, { key: "Enter", code: "Enter" });
    expect(handle.store.has("thread-active-01")).toBe(false);

    handle.dispose();
  });

  it("unstashes the active thread when clicking the composer send button, but ignores disabled button", () => {
    const storage = createMemoryStorage();
    const { doc, win, sendBtn } = buildDesktopFixture("thread-active-01");
    const handle = installSidebarStash({
      document: doc as unknown as Document,
      window: win as unknown as Window & typeof globalThis,
      storage,
    })!;

    handle.stashThread({ threadId: "thread-active-01", title: "Active Thread" });

    // Disabled send button must NOT unstash.
    sendBtn.disabled = true;
    dispatchDocEvent(doc, "click", sendBtn);
    expect(handle.store.has("thread-active-01")).toBe(true);

    // Enabled send button DOES unstash.
    sendBtn.disabled = false;
    dispatchDocEvent(doc, "click", sendBtn);
    expect(handle.store.has("thread-active-01")).toBe(false);

    handle.dispose();
  });

  it("unstashes the active thread on composer form submit", () => {
    const storage = createMemoryStorage();
    const { doc, win, form } = buildDesktopFixture("thread-active-01");
    const handle = installSidebarStash({
      document: doc as unknown as Document,
      window: win as unknown as Window & typeof globalThis,
      storage,
    })!;

    handle.stashThread({ threadId: "thread-active-01", title: "Active Thread" });
    dispatchDocEvent(doc, "submit", form);
    expect(handle.store.has("thread-active-01")).toBe(false);

    handle.dispose();
  });

  it("ignores Enter when composer submit button is disabled", () => {
    const storage = createMemoryStorage();
    const { doc, win, editor, sendBtn } = buildDesktopFixture("thread-active-01");
    const handle = installSidebarStash({
      document: doc as unknown as Document,
      window: win as unknown as Window & typeof globalThis,
      storage,
    })!;

    handle.stashThread({ threadId: "thread-active-01", title: "Active Thread" });
    sendBtn.disabled = true;
    dispatchDocEvent(doc, "keydown", editor, { key: "Enter", code: "Enter" });
    expect(handle.store.has("thread-active-01")).toBe(true);

    handle.dispose();
  });
});
