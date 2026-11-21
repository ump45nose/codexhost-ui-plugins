// Failure toast: pops up when a plugin enters the failed state, with "查看" to open the panel
// and a close button. Each (plugin id, reason) pair is shown at most once per page load.

import type { LoaderState } from "../core.ts";
import { el, resolvePlugins } from "./index.ts";

export const TOAST_ID = "cxp-toast";

export interface FailureToast {
  element: HTMLElement;
  update(state: LoaderState): void;
  destroy(): void;
}

export function createFailureToast(doc: Document, onView: () => void): FailureToast {
  const message = el(doc, "span");
  const viewBtn = el(doc, "button", { type: "button", className: "cxp-toast-view", text: "查看" });
  const closeBtn = el(doc, "button", { type: "button", className: "cxp-toast-close x", text: "✕", attrs: { "aria-label": "关闭" } });
  const toast = el(doc, "div", { id: TOAST_ID, className: "cxp-toast", attrs: { role: "status" } }, message, viewBtn, closeBtn);
  toast.hidden = true;

  const seen = new Set<string>();
  let currentId: string | null = null;
  const hide = () => {
    toast.hidden = true;
    currentId = null;
  };
  const attach = () => {
    if (!toast.isConnected && doc.body) doc.body.append(toast);
  };

  viewBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    hide();
    onView();
  });
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    hide();
  });
  attach();

  return {
    element: toast,
    update(state) {
      attach();
      const failed = resolvePlugins(state).filter((p) => p.status === "failed");
      if (currentId && !failed.some((p) => p.id === currentId)) hide();
      for (const p of failed) {
        const reason = p.reason || "未知原因";
        const key = `${p.id}\0${reason}`;
        if (seen.has(key)) continue;
        seen.add(key);
        currentId = p.id;
        message.textContent = `插件「${p.name}」已停用：${reason}`;
        toast.hidden = false;
      }
    },
    destroy: () => toast.remove(),
  };
}
