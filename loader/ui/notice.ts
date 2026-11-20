// Minimal failure notice for stage 1 (main window only); stage 2 replaces it with the panel and toast.

const NOTICE_ID = "cxp-failure-notice";
const lines = new Map<string, string>(); // plugin id → line; each page has its own loader bundle

export function showFailureNotice(doc: Document, id: string, name: string, reason: string): void {
  lines.set(id, `插件「${name}」已停用：${reason}`);
  render(doc);
}

export function clearFailureNotice(doc: Document, id: string): void {
  if (lines.delete(id)) render(doc);
}

function render(doc: Document): void {
  let box = doc.getElementById(NOTICE_ID);
  if (lines.size === 0) {
    box?.remove();
    return;
  }
  if (!doc.body) return;
  if (!box) {
    box = doc.createElement("div");
    box.id = NOTICE_ID;
    box.setAttribute("role", "alert");
    box.title = "点击关闭";
    box.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:8px 12px;" +
      "border-radius:8px;background:#b42318;color:#fff;font:12px/1.5 system-ui,sans-serif;" +
      "white-space:pre-line;cursor:pointer";
    box.addEventListener("click", () => box?.remove());
  }
  box.textContent = [...lines.values()].join("\n");
  if (!box.isConnected) doc.body.append(box);
}
