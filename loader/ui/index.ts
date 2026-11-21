// Loader UI entry point (main window only): mounts styles, rail entry, plugin panel, and toast,
// all driven strictly through window.__cxpLoaderV1.

import type { LoaderState, LoaderV1, LoaderWindow } from "../core.ts";
import type { PluginStatus, SettingField } from "../../plugins/types.ts";
import { createPluginPanel } from "./panel.ts";
import { createRailEntry } from "./rail-entry.ts";
import { injectStyles } from "./style.ts";
import { createFailureToast } from "./toast.ts";

export interface ResolvedPlugin {
  id: string;
  name: string;
  enabled: boolean;
  status: PluginStatus;
  reason?: string;
  settings: Record<string, unknown>;
  settingFields: SettingField[];
}

export function el(
  doc: Document,
  tag: string,
  opts: { id?: string; className?: string; text?: string; type?: string; attrs?: Record<string, string> } = {},
  ...children: HTMLElement[]
): HTMLElement {
  const node = doc.createElement(tag) as HTMLElement & { type?: string };
  if (opts.id) node.id = opts.id;
  if (opts.className) node.className = opts.className;
  if (opts.type) node.type = opts.type;
  if (opts.text !== undefined) node.textContent = opts.text;
  for (const [k, v] of Object.entries(opts.attrs ?? {})) node.setAttribute(k, v);
  if (children.length > 0) node.append?.(...children);
  return node;
}

export function resolvePlugins(state: LoaderState): ResolvedPlugin[] {
  const seen = new Set<string>();
  const result: ResolvedPlugin[] = (state.daemon?.plugins ?? []).map((p) => {
    seen.add(p.id);
    const local = state.local[p.id];
    const status: PluginStatus = !p.enabled
      ? "off"
      : p.status === "failed" || local?.status === "failed"
        ? "failed"
        : (local?.status ?? p.status);
    const reason = status === "off" ? undefined : p.status === "failed" ? p.reason : (local?.reason ?? p.reason);
    return { id: p.id, name: p.name, enabled: p.enabled, status, reason, settings: p.settings ?? {}, settingFields: p.settingFields ?? [] };
  });
  for (const [id, local] of Object.entries(state.local)) {
    if (!seen.has(id)) {
      result.push({ id, name: id, enabled: local.status !== "off", status: local.status, reason: local.reason, settings: {}, settingFields: [] });
    }
  }
  return result;
}

export function formatCheckedAt(checkedAt: unknown, now = Date.now()): string {
  if (checkedAt == null || checkedAt === "") return "尚未检查更新";
  const ts = typeof checkedAt === "number" ? checkedAt : Date.parse(String(checkedAt));
  if (!Number.isFinite(ts)) return "尚未检查更新";
  const min = Math.max(0, Math.floor((now - ts) / 60_000));
  if (min < 1) return "刚刚检查更新";
  if (min < 60) return `${min} 分钟前检查更新`;
  const hr = Math.floor(min / 60);
  return hr < 24 ? `${hr} 小时前检查更新` : `${Math.floor(hr / 24)} 天前检查更新`;
}

export function mountLoaderUi(win: LoaderWindow, loader: LoaderV1): () => void {
  const doc = win.document;
  if (loader.window !== "main" || !doc || typeof doc.createElement !== "function") return () => {};

  let unmounted = false;
  let stop: (() => void) | null = null;

  const mount = () => {
    if (unmounted || stop) return;
    injectStyles(doc);
    const rail = createRailEntry(doc, () => panel.toggle());
    const panel = createPluginPanel(doc, loader, {
      onOpenChange: (open) => rail.setActive(open),
      isInsideTrigger: (t) => Boolean(t && typeof rail.element.contains === "function" && rail.element.contains(t as Node)),
    });
    const toast = createFailureToast(doc, () => panel.open());
    const sync = (state: LoaderState) => {
      rail.ensureMounted();
      rail.setHasFailure(resolvePlugins(state).some((p) => p.status === "failed"));
      panel.update(state);
      toast.update(state);
    };
    const unsubscribe = loader.subscribe(sync);
    sync(loader.getState());
    stop = () => {
      unsubscribe();
      rail.destroy();
      panel.destroy();
      toast.destroy();
    };
  };

  if (doc.body) mount();
  else doc.addEventListener?.("DOMContentLoaded", mount);

  return () => {
    unmounted = true;
    doc.removeEventListener?.("DOMContentLoaded", mount);
    stop?.();
  };
}
