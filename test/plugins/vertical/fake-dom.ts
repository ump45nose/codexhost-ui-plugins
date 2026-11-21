/** Minimal in-memory DOM + MutationObserver for Node vitest (no jsdom dependency). */

export class FakeStyle {
  private readonly props = new Map<string, string>();
  [key: string]: unknown;

  getPropertyValue(name: string): string {
    return this.props.get(name) ?? (typeof this[name] === "string" ? (this[name] as string) : "");
  }

  setProperty(name: string, value: string): void {
    this.props.set(name, value);
    this[name] = value;
  }

  parseInline(cssText: string): void {
    for (const part of cssText.split(";")) {
      const idx = part.indexOf(":");
      if (idx < 0) continue;
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (key) this.setProperty(key, val);
    }
  }
}

export class FakeElement extends EventTarget {
  readonly nodeType = 1;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly style = new FakeStyle();
  readonly classList = {
    add: (...tokens: string[]) => {
      const existing = new Set(this.className.split(/\s+/u).filter(Boolean));
      for (const token of tokens) existing.add(token);
      this.className = [...existing].join(" ");
    },
    contains: (token: string) => this.className.split(/\s+/u).includes(token),
  };
  parentElement: FakeElement | null = null;
  ownerDocument: FakeDocument;
  tagName: string;
  id = "";
  className = "";
  textContent = "";
  title = "";
  type = "";
  src = "";
  alt = "";
  draggable = true;
  hidden = false;
  lang = "";

  constructor(tagName: string, ownerDocument: FakeDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get parentNode(): FakeElement | null {
    return this.parentElement;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get lastElementChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }

  getAttribute(name: string): string | null {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    const str = String(value);
    if (name === "id") this.id = str;
    else if (name === "class") this.className = str;
    else if (name === "style") this.style.parseInline(str);
    this.attributes.set(name, str);
    this.ownerDocument.notifyMutation({
      type: "attributes",
      target: this as unknown as Node,
      attributeName: name,
    } as MutationRecord);
  }

  removeAttribute(name: string): void {
    if (name === "id") this.id = "";
    else if (name === "class") this.className = "";
    this.attributes.delete(name);
    this.ownerDocument.notifyMutation({
      type: "attributes",
      target: this as unknown as Node,
      attributeName: name,
    } as MutationRecord);
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  appendChild(child: FakeElement): FakeElement {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    this.ownerDocument.notifyMutation({
      type: "childList",
      target: this as unknown as Node,
    } as MutationRecord);
    return child;
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) this.appendChild(node);
    }
  }

  prepend(child: FakeElement): void {
    child.remove();
    child.parentElement = this;
    this.children.unshift(child);
    this.ownerDocument.notifyMutation({
      type: "childList",
      target: this as unknown as Node,
    } as MutationRecord);
  }

  insertBefore(child: FakeElement, ref: FakeElement | null): FakeElement {
    child.remove();
    child.parentElement = this;
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx < 0) this.children.push(child);
    else this.children.splice(idx, 0, child);
    this.ownerDocument.notifyMutation({
      type: "childList",
      target: this as unknown as Node,
    } as MutationRecord);
    return child;
  }

  replaceChildren(...nodes: (FakeElement | string)[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    for (const node of nodes) {
      if (node instanceof FakeElement) {
        node.remove();
        node.parentElement = this;
        this.children.push(node);
      }
    }
    this.ownerDocument.notifyMutation({
      type: "childList",
      target: this as unknown as Node,
    } as MutationRecord);
  }

  remove(): void {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    const idx = parent.children.indexOf(this);
    if (idx >= 0) parent.children.splice(idx, 1);
    this.parentElement = null;
    this.ownerDocument.notifyMutation({
      type: "childList",
      target: parent as unknown as Node,
    } as MutationRecord);
  }

  contains(other: unknown): boolean {
    let cur = other as FakeElement | null;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  click(): void {
    this.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
  }

  override dispatchEvent(event: Event): boolean {
    Object.defineProperty(event, "target", { configurable: true, value: this });
    let cur: FakeElement | null = this;
    const chain: FakeElement[] = [];
    while (cur) {
      chain.push(cur);
      cur = cur.parentElement;
    }
    // Capture on document first (listeners added with capture=true on document)
    this.ownerDocument.dispatchEvent(event);
    for (const node of chain) {
      EventTarget.prototype.dispatchEvent.call(node, event);
      if (!event.bubbles) break;
    }
    return !event.defaultPrevented;
  }

  matches(selector: string, scope?: FakeElement): boolean {
    return selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .some((part) => matchComplexSelector(this, part, scope));
  }

  closest<T extends FakeElement = FakeElement>(selector: string): T | null {
    let cur: FakeElement | null = this;
    while (cur) {
      if (cur.matches(selector)) return cur as T;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return (this.querySelectorAll<T>(selector)[0] as T | undefined) ?? null;
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const results: T[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child.matches(selector, this)) results.push(child as T);
        visit(child);
      }
    };
    visit(this);
    return results;
  }
}

function matchSimpleSelector(el: FakeElement, simple: string): boolean {
  let rest = simple.trim();
  if (!rest) return false;

  const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest);
  if (tagMatch?.[1]) {
    if (el.tagName !== tagMatch[1].toUpperCase()) return false;
    rest = rest.slice(tagMatch[1].length);
  }

  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m?.[1]) return false;
      if (!el.classList.contains(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith("#")) {
      const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m?.[1]) return false;
      if (el.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith("[")) {
      const m = /^\[([^\]=*~]+)(?:(\*?=)"([^"]*)")?\]/.exec(rest);
      if (!m?.[1]) return false;
      const attr = m[1].trim();
      const op = m[2];
      const expected = m[3];
      const actual = el.getAttribute(attr);
      if (op === "=") {
        if (actual !== expected) return false;
      } else if (op === "*=") {
        if (actual === null || !actual.includes(expected ?? "")) return false;
      } else {
        if (actual === null) return false;
      }
      rest = rest.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

function matchComplexSelector(el: FakeElement, selector: string, scope?: FakeElement): boolean {
  const trimmed = selector.trim();
  if (trimmed.startsWith(":scope >")) {
    const childSel = trimmed.slice(":scope >".length).trim();
    return Boolean(scope && el.parentElement === scope && matchSimpleSelector(el, childSel));
  }
  const tokens = trimmed.split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return false;
  if (!matchSimpleSelector(el, tokens[tokens.length - 1]!)) return false;
  let cur = el.parentElement;
  for (let i = tokens.length - 2; i >= 0; i -= 1) {
    const token = tokens[i]!;
    let found = false;
    while (cur) {
      if (matchSimpleSelector(cur, token)) {
        found = true;
        cur = cur.parentElement;
        break;
      }
      cur = cur.parentElement;
    }
    if (!found) return false;
  }
  return true;
}

interface ObserverEntry {
  callback: MutationCallback;
  target: FakeElement;
  options: MutationObserverInit;
}

export class FakeDocument extends EventTarget {
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  defaultView: FakeWindow | null = null;
  readonly observers = new Set<ObserverEntry>();

  constructor() {
    super();
    this.documentElement = new FakeElement("html", this);
    this.head = new FakeElement("head", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createElementNS(_ns: string, tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  getElementById(id: string): FakeElement | null {
    return this.querySelector(`#${id}`);
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return this.documentElement.querySelector<T>(selector);
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    return this.documentElement.querySelectorAll<T>(selector);
  }

  notifyMutation(record: MutationRecord): void {
    for (const entry of this.observers) {
      if (
        record.type === "attributes" &&
        entry.options.attributeFilter &&
        record.attributeName &&
        !entry.options.attributeFilter.includes(record.attributeName)
      ) {
        continue;
      }
      if (record.type === "attributes" && !entry.options.attributes) continue;
      if (record.type === "childList" && !entry.options.childList) continue;
      if (entry.target.contains(record.target)) {
        entry.callback([record], {} as MutationObserver);
      }
    }
  }
}

export class FakeStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) ?? null) : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
}

export class FakeWindow extends EventTarget {
  innerWidth: number;
  innerHeight = 768;
  readonly localStorage = new FakeStorage();
  readonly document: FakeDocument;
  [key: string]: unknown;

  constructor(doc: FakeDocument, width = 1280) {
    super();
    this.document = doc;
    this.innerWidth = width;
    doc.defaultView = this;
  }

  setTimeout = globalThis.setTimeout.bind(globalThis);
  clearTimeout = globalThis.clearTimeout.bind(globalThis);
}

/** Installs a global MutationObserver wired to FakeDocument instances; returns a restore function. */
export function installFakeMutationObserver(): () => void {
  const Original = globalThis.MutationObserver;
  class FakeMutationObserver {
    private readonly callback: MutationCallback;
    private entry: ObserverEntry | null = null;
    private doc: FakeDocument | null = null;

    constructor(callback: MutationCallback) {
      this.callback = callback;
    }

    observe(target: Node, options: MutationObserverInit = {}): void {
      const el = target as unknown as FakeElement;
      if (!el?.ownerDocument) return;
      this.disconnect();
      this.doc = el.ownerDocument;
      this.entry = { callback: this.callback, target: el, options };
      this.doc.observers.add(this.entry);
    }

    disconnect(): void {
      if (this.doc && this.entry) {
        this.doc.observers.delete(this.entry);
      }
      this.doc = null;
      this.entry = null;
    }

    takeRecords(): MutationRecord[] {
      return [];
    }
  }
  globalThis.MutationObserver = FakeMutationObserver as unknown as typeof MutationObserver;
  return () => {
    globalThis.MutationObserver = Original;
  };
}
