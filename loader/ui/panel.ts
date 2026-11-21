// Plugin panel popover: lists all plugins, statuses, switches, failure reasons with retry,
// SettingField controls (text, toggle, number, exclude-list), and build/update footer.

import type { LoaderState, LoaderV1 } from "../core.ts";
import type { SettingField } from "../../plugins/types.ts";
import { el, formatCheckedAt, resolvePlugins, type ResolvedPlugin } from "./index.ts";

export const PANEL_ID = "cxp-plugin-panel";

export interface PluginPanel {
  element: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  update(state: LoaderState): void;
  destroy(): void;
}

const STATUS_META: Record<ResolvedPlugin["status"], [string, string]> = {
  active: ["正常", "cxp-status"],
  failed: ["已停用", "cxp-status bad"],
  off: ["已关闭", "cxp-status off"],
  dormant: ["休眠", "cxp-status off"],
};

export function createPluginPanel(
  doc: Document,
  loader: LoaderV1,
  options: { onOpenChange?: (open: boolean) => void; isInsideTrigger?: (target: EventTarget | null) => boolean } = {},
): PluginPanel {
  const list = el(doc, "div", { className: "cxp-list" });
  const footerText = el(doc, "span");
  const footer = el(doc, "footer", {}, footerText);
  const panel = el(
    doc,
    "section",
    { id: PANEL_ID, className: "cxp-panel", attrs: { "aria-label": "插件面板" } },
    el(doc, "header", {}, el(doc, "b", { text: "插件" }), el(doc, "span", { text: "codexhost-ui-plugins" })),
    list,
    footer,
  );
  panel.hidden = true;

  let latest = loader.getState();
  const attach = () => {
    if (!panel.isConnected && doc.body) doc.body.append(panel);
  };
  const setOpen = (open: boolean) => {
    attach();
    if (Boolean(panel.hidden) === !open) return;
    panel.hidden = !open;
    options.onOpenChange?.(open);
    if (open) render(latest);
  };

  const onDocClick = (e: Event) => {
    if (panel.hidden) return;
    if (e.target && panel.contains(e.target as Node)) return;
    if (options.isInsideTrigger?.(e.target)) return;
    setOpen(false);
  };
  const onKeyDown = (e: Event) => {
    if (!panel.hidden && (e as KeyboardEvent).key === "Escape") setOpen(false);
  };
  doc.addEventListener("click", onDocClick);
  doc.addEventListener("keydown", onKeyDown);

  function render(state: LoaderState): void {
    attach();
    const activeEl = doc.activeElement as HTMLInputElement | null;
    const activeKey = activeEl && panel.contains(activeEl) ? activeEl.getAttribute("data-cxp-field") : null;
    const selStart = activeKey ? activeEl!.selectionStart : null;
    const selEnd = activeKey ? activeEl!.selectionEnd : null;

    list.replaceChildren();
    if (!state.daemon) {
      list.append(el(doc, "div", { className: "cxp-row", text: "正在连接常驻程序…" }));
    } else {
      for (const p of resolvePlugins(state)) list.append(renderRow(p, activeKey, activeEl));
    }

    const buildId = state.daemon?.buildId ?? state.buildId;
    const upd = state.daemon?.update;
    footer.className = upd?.error ? "bad" : "";
    footerText.textContent = upd?.error
      ? `更新失败：${upd.error}，仍在运行 ${buildId} · 看日志 ~/Library/Logs/codexhost-ui-plugins`
      : `版本 ${buildId} · ${formatCheckedAt(upd?.checkedAt)}`;

    if (activeKey) {
      const next = list.querySelector(`[data-cxp-field="${activeKey}"]`) as HTMLInputElement | null;
      if (next) {
        next.focus();
        if (next.type === "text" && selStart !== null && selEnd !== null) next.setSelectionRange(selStart, selEnd);
      }
    }
  }

  function renderRow(p: ResolvedPlugin, activeKey: string | null, activeEl: HTMLInputElement | null): HTMLElement {
    const [statusText, statusCls] = STATUS_META[p.status];
    const badge = el(doc, "span", { className: statusCls, text: statusText });
    if (p.status === "dormant") badge.title = "fork 版同功能在场，插件已休眠";

    const row = el(
      doc,
      "div",
      { className: "cxp-row", attrs: { "data-plugin-id": p.id } },
      el(
        doc,
        "div",
        { className: "cxp-top" },
        el(doc, "span", { className: "cxp-name", text: p.name }),
        badge,
        makeSwitch(doc, p.enabled, `${p.name} 开关`, () => loader.setEnabled(p.id, !p.enabled)),
      ),
    );

    if (p.status === "failed") {
      const retry = el(doc, "button", { type: "button", text: "重试" });
      retry.addEventListener("click", () => loader.retry(p.id));
      row.append(el(doc, "div", { className: "cxp-reason" }, el(doc, "span", { text: p.reason || "未知原因" }), retry));
    }
    if (p.settingFields.length > 0) {
      row.append(el(doc, "div", { className: "cxp-set" }, ...p.settingFields.map((f) => renderField(p, f, activeKey, activeEl))));
    }
    return row;
  }

  function renderField(
    p: ResolvedPlugin,
    field: SettingField,
    activeKey: string | null,
    activeEl: HTMLInputElement | null,
  ): HTMLElement {
    const fieldId = `${p.id}:${field.key}`;
    const raw = p.settings[field.key];

    if (field.type === "toggle") {
      const on = typeof raw === "boolean" ? raw : field.default;
      const sw = makeSwitch(doc, on, field.label, () => loader.setSettings(p.id, { [field.key]: !on }));
      sw.setAttribute("data-cxp-field", fieldId);
      return el(doc, "div", { className: "cxp-field-toggle" }, el(doc, "label", { text: field.label }), sw);
    }

    if (field.type === "exclude-list") {
      const excluded = new Set<string>(Array.isArray(raw) ? raw.map(String) : (field.default ?? []));
      const chips = field.options.map((opt) => {
        const off = excluded.has(opt);
        const chip = el(doc, "button", {
          type: "button",
          className: off ? "cxp-chip off" : "cxp-chip",
          text: opt,
          attrs: { "aria-pressed": off ? "false" : "true", "data-cxp-chip": opt },
        });
        chip.addEventListener("click", () => {
          const next = new Set(excluded);
          if (next.has(opt)) next.delete(opt);
          else next.add(opt);
          loader.setSettings(p.id, { [field.key]: [...next] });
        });
        return chip;
      });
      return el(doc, "div", { className: "cxp-field" }, el(doc, "label", { text: field.label }), el(doc, "div", { className: "cxp-chips" }, ...chips));
    }

    const input = el(doc, "input", { type: field.type, attrs: { "data-cxp-field": fieldId } }) as HTMLInputElement;
    const commit = () => {
      if (field.type === "text") return loader.setSettings(p.id, { [field.key]: input.value });
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) return void (input.value = String(typeof raw === "number" ? raw : field.default));
      const clamped = Math.min(field.max ?? parsed, Math.max(field.min ?? parsed, parsed));
      input.value = String(clamped);
      loader.setSettings(p.id, { [field.key]: clamped });
    };
    if (field.type === "number") {
      if (field.min !== undefined) input.setAttribute("min", String(field.min));
      if (field.max !== undefined) input.setAttribute("max", String(field.max));
      if (field.step !== undefined) input.setAttribute("step", String(field.step));
      input.value = activeKey === fieldId && activeEl ? activeEl.value : String(typeof raw === "number" ? raw : field.default);
    } else {
      input.value = activeKey === fieldId && activeEl ? activeEl.value : String(raw ?? field.default ?? "");
    }
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") commit();
    });
    return el(doc, "div", { className: "cxp-field" }, el(doc, "label", { text: field.label }), input);
  }

  attach();
  return {
    element: panel,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(Boolean(panel.hidden)),
    update(state) {
      latest = state;
      if (!panel.hidden) render(state);
    },
    destroy() {
      doc.removeEventListener("click", onDocClick);
      doc.removeEventListener("keydown", onKeyDown);
      panel.remove();
    },
  };
}

function makeSwitch(doc: Document, on: boolean, label: string, onClick: () => void): HTMLButtonElement {
  const sw = el(doc, "button", {
    type: "button",
    className: on ? "cxp-sw on" : "cxp-sw",
    attrs: { role: "switch", "aria-checked": on ? "true" : "false", "aria-label": label },
  }) as HTMLButtonElement;
  sw.addEventListener("click", onClick);
  return sw;
}
