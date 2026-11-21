// Styles for the loader UI (rail entry, plugin panel, failure toast), following Desktop's light/dark theme.

export const STYLE_ID = "cxp-ui-style";

const DARK_VARS =
  "--cxp-bg: #1e1e1d; --cxp-rail: #232322; --cxp-panel: #2a2a29; --cxp-line: #3a3a38; " +
  "--cxp-text: #ecebe6; --cxp-muted: #a3a19a; --cxp-accent: #5b9dff; --cxp-ok: #56c26d; " +
  "--cxp-bad: #ff7a6b; --cxp-badbg: #3b2421; --cxp-hover: #333331;";

export const UI_CSS = [
  `:root { --cxp-bg: #f7f6f2; --cxp-rail: #f1efe9; --cxp-panel: #fff; --cxp-line: #e4e2db; --cxp-text: #1f1f1d; --cxp-muted: #6f6d66; --cxp-accent: #1f6feb; --cxp-ok: #1a7f37; --cxp-bad: #b42318; --cxp-badbg: #fdecea; --cxp-hover: #ecebe5; }`,
  `:root.dark, :root[data-theme="dark"], :root[data-color-scheme="dark"], body.dark, body[data-theme="dark"], body[data-color-scheme="dark"] { ${DARK_VARS} }`,
  `@media (prefers-color-scheme: dark) { :root:not(.light):not([data-theme="light"]):not([data-color-scheme="light"]) { ${DARK_VARS} } }`,
  `.cxp-plug { width:36px; height:36px; border-radius:8px; display:grid; place-items:center; color:var(--cxp-text); cursor:pointer; position:relative; border:0; background:transparent; padding:0; font:inherit; }`,
  `.cxp-plug.active, .cxp-plug:hover { background:var(--cxp-hover); }`,
  `.cxp-plug .cxp-dot { position:absolute; top:6px; right:6px; width:7px; height:7px; border-radius:50%; background:var(--cxp-bad); }`,
  `.cxp-plug.cxp-plug-fallback { position:fixed; left:14px; bottom:96px; z-index:2147483645; }`,
  `.cxp-panel { position:fixed; left:72px; bottom:56px; z-index:2147483646; width:360px; max-height:calc(100vh - 80px); overflow-y:auto; background:var(--cxp-panel); color:var(--cxp-text); border:1px solid var(--cxp-line); border-radius:12px; box-shadow:0 8px 28px rgba(0,0,0,.14); font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif; box-sizing:border-box; }`,
  `.cxp-panel *, .cxp-toast * { box-sizing:border-box; }`,
  `.cxp-panel header { display:flex; justify-content:space-between; align-items:baseline; padding:12px 14px 8px; }`,
  `.cxp-panel header b { font-size:14px; font-weight:600; }`,
  `.cxp-panel header span { font-size:11px; color:var(--cxp-muted); }`,
  `.cxp-row { padding:10px 14px; border-top:1px solid var(--cxp-line); }`,
  `.cxp-row .cxp-top { display:flex; align-items:center; gap:8px; }`,
  `.cxp-row .cxp-name { flex:1; font-weight:500; }`,
  `.cxp-status { font-size:12px; color:var(--cxp-ok); }`,
  `.cxp-status.bad { color:var(--cxp-bad); }`,
  `.cxp-status.off { color:var(--cxp-muted); }`,
  `.cxp-reason { margin-top:6px; padding:6px 8px; border-radius:6px; background:var(--cxp-badbg); color:var(--cxp-bad); font-size:12px; display:flex; justify-content:space-between; gap:8px; align-items:center; }`,
  `.cxp-reason button { font:inherit; font-size:12px; border:0; background:none; color:var(--cxp-accent); cursor:pointer; padding:0; white-space:nowrap; }`,
  `.cxp-set { margin-top:8px; display:grid; gap:6px; font-size:12px; color:var(--cxp-muted); }`,
  `.cxp-field { display:grid; gap:4px; }`,
  `.cxp-field-toggle { display:flex; align-items:center; justify-content:space-between; gap:8px; }`,
  `.cxp-set input[type="text"], .cxp-set input[type="number"] { width:100%; font:inherit; color:var(--cxp-text); background:var(--cxp-bg); border:1px solid var(--cxp-line); border-radius:6px; padding:5px 8px; }`,
  `.cxp-chips { display:flex; flex-wrap:wrap; gap:6px; }`,
  `.cxp-chip { font:inherit; background:transparent; border:1px solid var(--cxp-line); border-radius:999px; padding:2px 8px; color:var(--cxp-text); cursor:pointer; user-select:none; }`,
  `.cxp-chip.off { color:var(--cxp-muted); text-decoration:line-through; }`,
  `.cxp-sw { width:30px; height:18px; border-radius:9px; background:var(--cxp-line); position:relative; cursor:pointer; flex:none; border:0; padding:0; }`,
  `.cxp-sw::after { content:""; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:#fff; transition:transform .15s; }`,
  `.cxp-sw.on { background:var(--cxp-accent); }`,
  `.cxp-sw.on::after { transform:translateX(12px); }`,
  `.cxp-panel footer { border-top:1px solid var(--cxp-line); padding:8px 14px 10px; font-size:11px; color:var(--cxp-muted); display:flex; justify-content:space-between; gap:8px; }`,
  `.cxp-panel footer.bad { color:var(--cxp-bad); }`,
  `.cxp-toast { position:fixed; right:16px; bottom:16px; z-index:2147483647; max-width:380px; background:var(--cxp-panel); color:var(--cxp-text); border:1px solid var(--cxp-line); border-left:3px solid var(--cxp-bad); border-radius:8px; padding:9px 12px; display:flex; gap:12px; align-items:center; box-shadow:0 6px 20px rgba(0,0,0,.12); font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif; box-sizing:border-box; }`,
  `.cxp-toast span { flex:1; }`,
  `.cxp-toast button { font:inherit; border:0; background:none; color:var(--cxp-accent); cursor:pointer; padding:0; white-space:nowrap; }`,
  `.cxp-toast .x { color:var(--cxp-muted); }`,
  `.cxp-panel[hidden], .cxp-toast[hidden], .cxp-dot[hidden] { display:none !important; }`,
].join("\n");

export function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const host = doc.head ?? doc.documentElement ?? doc.body;
  if (!host || typeof host.append !== "function") return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = UI_CSS;
  host.append(style);
}
