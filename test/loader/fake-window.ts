// Hand-made page stand-in for loader tests: a lightweight DOM/window with just what the loader and UI touch.
import type { DaemonPlugin, DaemonState, LoaderV1, LoaderWindow } from "../../loader/core.ts";

class FakeClassList {
  private el: FakeElement;
  constructor(el: FakeElement) {
    this.el = el;
  }
  private list(): string[] {
    return this.el.className.split(/\s+/).filter(Boolean);
  }
  contains(cls: string): boolean {
    return this.list().includes(cls);
  }
  add(...names: string[]): void {
    const set = new Set(this.list());
    for (const n of names) if (n) set.add(n);
    this.el.className = [...set].join(" ");
  }
  remove(...names: string[]): void {
    const drop = new Set(names);
    this.el.className = this.list().filter((c) => !drop.has(c)).join(" ");
  }
  toggle(name: string, force?: boolean): boolean {
    const has = this.contains(name);
    const next = force ?? !has;
    if (next) this.add(name);
    else this.remove(name);
    return next;
  }
}

export class FakeElement {
  tagName: string;
  id = "";
  className = "";
  title = "";
  type = "";
  value = "";
  innerHTML = "";
  hidden = false;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  style = { cssText: "" };
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event?: any) => void>>();
  classList: FakeClassList;
  private _text = "";
  private doc: FakeDocument;
  private _rect = { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 };

  constructor(doc: FakeDocument, tag = "div") {
    this.doc = doc;
    this.tagName = tag.toUpperCase();
    this.classList = new FakeClassList(this);
  }

  get isConnected(): boolean {
    let cur: FakeElement | null = this;
    while (cur) {
      if (cur === this.doc.body || cur === this.doc.head || cur === this.doc.documentElement) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  get nextSibling(): FakeElement | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    return idx >= 0 && idx + 1 < this.parentNode.children.length ? this.parentNode.children[idx + 1] : null;
  }

  get textContent(): string {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }

  set textContent(val: string) {
    this._text = val ?? "";
    for (const c of this.children) c.parentNode = null;
    this.children = [];
  }

  setAttribute(name: string, val: string): void {
    this.attributes.set(name, String(val));
    if (name === "id") this.id = String(val);
    if (name === "class") this.className = String(val);
    if (name === "title") this.title = String(val);
  }

  getAttribute(name: string): string | null {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    if (name === "title") return this.title || null;
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: FakeElement[]): void {
    for (const n of nodes) {
      if (n.parentNode) n.remove();
      n.parentNode = this;
      this.children.push(n);
    }
    this.doc.notifyMutation();
  }

  insertBefore(node: FakeElement, ref: FakeElement | null): FakeElement {
    if (node.parentNode) node.remove();
    node.parentNode = this;
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx >= 0) this.children.splice(idx, 0, node);
    else this.children.push(node);
    this.doc.notifyMutation();
    return node;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }

  remove(): void {
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx >= 0) this.parentNode.children.splice(idx, 1);
    this.parentNode = null;
    this.doc.notifyMutation();
  }

  contains(other: unknown): boolean {
    if (other === this) return true;
    return this.children.some((c) => c.contains(other));
  }

  addEventListener(type: string, fn: (event?: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (event?: any) => void): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  dispatchEvent(event: { type: string; target?: any; key?: string; stopPropagation?: () => void }): void {
    let stopped = false;
    const ev = {
      target: this,
      ...event,
      stopPropagation() {
        stopped = true;
      },
    };
    for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(ev);
    if (!stopped && event.type === "click") {
      this.doc.dispatchEvent(ev);
    }
  }

  click(): void {
    this.dispatchEvent({ type: "click" });
  }

  focus(): void {
    this.doc.activeElement = this;
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  setRect(rect: Partial<typeof this._rect>): void {
    this._rect = { ...this._rect, ...rect };
  }

  getBoundingClientRect() {
    return this._rect;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
    const out: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const child of node.children) {
        if (parts.some((p) => matchesSelector(child, p))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function matchesSelector(el: FakeElement, selector: string): boolean {
  // Supports simple selectors: tag, #id, .class, [attr], [attr="val"], and compound combinations.
  const tokens = selector.match(/(#[-\w]+|\.[-\w]+|\[[^\]]+\]|^[a-zA-Z][-\w]*)/g);
  if (!tokens || tokens.join("") !== selector) return false;
  for (const tok of tokens) {
    if (tok.startsWith("#")) {
      if (el.id !== tok.slice(1)) return false;
    } else if (tok.startsWith(".")) {
      if (!el.classList.contains(tok.slice(1))) return false;
    } else if (tok.startsWith("[")) {
      const m = tok.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
      if (!m) return false;
      const val = el.getAttribute(m[1]);
      if (m[2] !== undefined ? val !== m[2] : val === null) return false;
    } else {
      if (el.tagName !== tok.toUpperCase()) return false;
    }
  }
  return true;
}

export class FakeDocument {
  documentElement: FakeElement;
  head: FakeElement;
  body: FakeElement;
  activeElement: FakeElement | null = null;
  defaultView: { innerHeight: number } = { innerHeight: 800 };
  listeners = new Map<string, Array<(event?: any) => void>>();
  mutationCallbacks = new Set<() => void>();

  constructor() {
    this.documentElement = new FakeElement(this, "html");
    this.head = new FakeElement(this, "head");
    this.body = new FakeElement(this, "body");
    this.documentElement.children.push(this.head, this.body);
    this.head.parentNode = this.documentElement;
    this.body.parentNode = this.documentElement;
  }

  hasFocus = () => true;

  createElement = (tag = "div") => new FakeElement(this, tag);

  getElementById = (id: string): FakeElement | null => {
    const walk = (node: FakeElement): FakeElement | null => {
      if (node.id === id) return node;
      for (const c of node.children) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this.documentElement);
  };

  querySelectorAll = (selector: string): FakeElement[] => this.documentElement.querySelectorAll(selector);
  querySelector = (selector: string): FakeElement | null => this.documentElement.querySelector(selector);

  addEventListener(type: string, fn: (event?: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (event?: any) => void): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  dispatchEvent(event: { type: string; target?: any; key?: string }): void {
    for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event);
  }

  notifyMutation(): void {
    for (const cb of [...this.mutationCallbacks]) cb();
  }
}

export function fakeWindow(kind: "main" | "pet" = "main") {
  const sent: any[] = [];
  const doc = new FakeDocument();
  const win: LoaderWindow = {
    __cxpWindow: kind,
    document: doc as unknown as Document,
    addEventListener() {},
    __cxpDaemon: (json: string) => sent.push(JSON.parse(json)),
    __codexhostHostRoutingV1: {},
  };
  return {
    win,
    doc,
    sent,
    loader: () => win.__cxpLoaderV1 as LoaderV1,
    register: (id: string, activate: (api: any) => any, forkGuards: string[] = []) =>
      win.__cxpLoaderRegister(id, activate, { forkGuards }),
    push: (
      plugins: Array<Partial<DaemonPlugin> & { id: string }>,
      extra: { buildId?: string; update?: DaemonState["update"] } = {},
    ) => {
      const state: DaemonState = {
        buildId: extra.buildId ?? "test",
        plugins: plugins.map((p) => ({
          name: p.id,
          enabled: true,
          settings: {},
          settingFields: [],
          status: "active",
          ...p,
        })),
        update: extra.update ?? { checkedAt: null },
      };
      win.__cxpReceive({ type: "state", ...state });
    },
    statuses: (plugin: string) => sent.filter((m) => m.type === "status" && m.plugin === plugin).map((m) => m.state),
  };
}
