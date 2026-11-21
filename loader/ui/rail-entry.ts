// Left-rail puzzle button: mounted above Desktop's bottom "!" icon, re-inserted after React
// re-renders, with a red dot while any plugin is in the failed state.

export const RAIL_ENTRY_ID = "cxp-rail-entry";

const PUZZLE_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 7h3a1 1 0 0 0 1-1v-1a2 2 0 0 1 4 0v1a1 1 0 0 0 1 1h3a1 1 0 0 1 1 1v3a1 1 0 0 0 1 1h1a2 2 0 0 1 0 4h-1a1 1 0 0 0-1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-1a2 2 0 0 0-4 0v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a2 2 0 0 0 0-4h-1a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1"/></svg>';
const ANCHOR_LABEL_RE = /usage|feedback|issue|help|反馈|帮助/i;
const PROFILE_LABEL_RE = /profile|account|avatar/i;

export interface RailEntry {
  element: HTMLButtonElement;
  setHasFailure(hasFailure: boolean): void;
  setActive(active: boolean): void;
  ensureMounted(): void;
  destroy(): void;
}

export function findRailAnchor(doc: Document): Element | null {
  const rail =
    doc.querySelector('nav[aria-label="App navigation"]') ??
    [...doc.querySelectorAll('nav, [role="navigation"]')].find((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.width <= 96 && r.left < 72;
    });
  if (!rail) return doc.querySelector("[data-cxp-rail-anchor]");
  const explicit = rail.querySelector("[data-cxp-rail-anchor]");
  if (explicit) return explicit;
  const items = [...rail.querySelectorAll('button, [role="button"], .i')].filter((e) => e.id !== RAIL_ENTRY_ID);
  const labelOf = (e: Element) => `${e.getAttribute("aria-label") ?? ""} ${e.getAttribute("title") ?? ""}`;
  const primary =
    items.find((e) => e.textContent?.trim() === "!") ??
    items.find((e) => ANCHOR_LABEL_RE.test(labelOf(e)));
  const anchor = primary ?? items.find((e) => PROFILE_LABEL_RE.test(labelOf(e))) ?? items[items.length - 1] ?? null;
  if (!anchor) return null;

  const flexDir = (el: Element): string | null => {
    const cs = doc.defaultView?.getComputedStyle?.(el);
    if (cs?.display?.includes("flex")) return cs.flexDirection;
    return el.classList.contains("flex-col") ? "column" : el.classList.contains("flex") ? "row" : null;
  };
  let cur: Element = anchor;
  while (cur.parentNode && cur.parentNode !== rail && rail.contains(cur.parentNode)) {
    const p = cur.parentNode as Element;
    const dir = flexDir(p);
    if (dir === "column" || dir === "column-reverse") break;
    const single = [...p.children].filter((c) => c.id !== RAIL_ENTRY_ID).length === 1;
    if (!single && dir !== "row" && dir !== "row-reverse") break;
    cur = p;
  }
  const parent = cur.parentNode as Element | null;
  if (!primary && parent && parent !== rail) {
    const first = [...parent.children].find((c) => c.id !== RAIL_ENTRY_ID);
    if (first) return first;
  }
  return cur;
}

export function createRailEntry(doc: Document, onToggle: () => void): RailEntry {
  const btn = doc.createElement("button") as HTMLButtonElement;
  btn.type = "button";
  btn.id = RAIL_ENTRY_ID;
  btn.className = "cxp-plug";
  btn.title = "插件";
  btn.setAttribute("aria-label", "插件");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = PUZZLE_SVG;

  const dot = doc.createElement("i");
  dot.className = "cxp-dot";
  dot.hidden = true;
  btn.append(dot);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onToggle();
  });

  let destroyed = false;
  let placing = false;
  let observer: MutationObserver | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const place = () => {
    if (destroyed || placing) return;
    placing = true;
    try {
      const anchor = findRailAnchor(doc);
      if (anchor?.parentNode) {
        btn.classList.remove("cxp-plug-fallback");
        if (btn.parentNode !== anchor.parentNode || btn.nextSibling !== anchor) anchor.parentNode.insertBefore(btn, anchor);
      } else if (!btn.isConnected && doc.body) {
        btn.classList.add("cxp-plug-fallback");
        doc.body.append(btn);
      }
    } finally {
      placing = false;
    }
  };
  const scheduleFallback = () => {
    if (fallbackTimer === null) fallbackTimer = setTimeout(() => { fallbackTimer = null; place(); }, 250);
  };
  const ensureMounted = () => {
    if (destroyed) return;
    place();
    if (!observer && typeof MutationObserver === "function" && doc.body) {
      observer = new MutationObserver(() => {
        if (btn.classList.contains("cxp-plug-fallback")) scheduleFallback();
        else if (!btn.isConnected) place();
      });
      observer.observe(doc.body, { childList: true, subtree: true });
    }
  };
  ensureMounted();

  return {
    element: btn,
    setHasFailure: (on) => (dot.hidden = !on),
    setActive: (on) => {
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-expanded", on ? "true" : "false");
    },
    ensureMounted,
    destroy() {
      destroyed = true;
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      fallbackTimer = null;
      observer?.disconnect();
      observer = null;
      btn.remove();
    },
  };
}
