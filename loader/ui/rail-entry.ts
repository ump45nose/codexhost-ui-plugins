// Left-rail puzzle button: mounted above Desktop's bottom "!" icon, re-inserted after React
// re-renders, with a red dot while any plugin is in the failed state.

export const RAIL_ENTRY_ID = "cxp-rail-entry";

const PUZZLE_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 7h3a1 1 0 0 0 1-1v-1a2 2 0 0 1 4 0v1a1 1 0 0 0 1 1h3a1 1 0 0 1 1 1v3a1 1 0 0 0 1 1h1a2 2 0 0 1 0 4h-1a1 1 0 0 0-1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-1a2 2 0 0 0-4 0v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a2 2 0 0 0 0-4h-1a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1"/></svg>';
const ANCHOR_LABEL_RE = /feedback|report|issue|bug|help|alert|status|通知|反馈|问题|帮助|状态/i;

export interface RailEntry {
  element: HTMLButtonElement;
  setHasFailure(hasFailure: boolean): void;
  setActive(active: boolean): void;
  ensureMounted(): void;
  destroy(): void;
}

export function findRailAnchor(doc: Document): Element | null {
  if (typeof doc.querySelector !== "function") return null;
  const explicit = doc.querySelector("[data-cxp-rail-anchor]");
  if (explicit || typeof doc.querySelectorAll !== "function") return explicit;

  for (const nav of doc.querySelectorAll('nav, [role="navigation"]')) {
    if (typeof nav.querySelectorAll !== "function") continue;
    const items = [...nav.querySelectorAll('button, [role="button"], .i')].filter((e) => e.id !== RAIL_ENTRY_ID);
    const hit =
      items.find((e) => e.textContent?.trim() === "!") ??
      items.find((e) => ANCHOR_LABEL_RE.test(`${e.getAttribute("aria-label") ?? ""} ${e.getAttribute("title") ?? ""}`));
    if (hit) return hit;
  }

  const vh = doc.defaultView?.innerHeight ?? 0;
  if (vh <= 0) return null;
  const bottom = [...doc.querySelectorAll('button, [role="button"]')]
    .filter((e) => e.id !== RAIL_ENTRY_ID && typeof e.getBoundingClientRect === "function")
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.width <= 56 && r.height > 0 && r.height <= 56 && r.left < 72 && r.bottom > vh * 0.5)
    .sort((a, b) => a.r.top - b.r.top);
  return bottom.length >= 2 ? bottom[bottom.length - 2].el : (bottom[0]?.el ?? null);
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
  btn.append?.(dot);
  btn.addEventListener("click", (e) => {
    e?.stopPropagation?.();
    onToggle();
  });

  let destroyed = false;
  let observer: MutationObserver | null = null;
  const place = () => {
    if (destroyed) return;
    const anchor = findRailAnchor(doc);
    if (anchor?.parentNode) {
      btn.classList?.remove?.("cxp-plug-fallback");
      if (btn.parentNode !== anchor.parentNode || btn.nextSibling !== anchor) anchor.parentNode.insertBefore(btn, anchor);
    } else if (!btn.isConnected && doc.body && typeof doc.body.append === "function") {
      btn.classList?.add?.("cxp-plug-fallback");
      doc.body.append(btn);
    }
  };
  const ensureMounted = () => {
    if (destroyed) return;
    place();
    if (!observer && typeof MutationObserver === "function" && doc.body) {
      observer = new MutationObserver(() => {
        if (!btn.isConnected || btn.classList?.contains?.("cxp-plug-fallback")) place();
      });
      observer.observe(doc.body, { childList: true, subtree: true });
    }
  };
  ensureMounted();

  return {
    element: btn,
    setHasFailure: (on) => (dot.hidden = !on),
    setActive: (on) => {
      btn.classList?.toggle?.("active", on);
      btn.setAttribute("aria-expanded", on ? "true" : "false");
    },
    ensureMounted,
    destroy() {
      destroyed = true;
      observer?.disconnect();
      observer = null;
      btn.remove();
    },
  };
}
