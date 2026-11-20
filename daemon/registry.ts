// Plugin registry: dist/manifest.json + each plugins/<id>/plugin.ts (rewrites, task) + local config.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChunkRewrite, PluginManifest, SettingField } from "../plugins/types.ts";
import { type Config, readConfig, writeConfig } from "./config.ts";

export type PageWindow = "main" | "pet";

export interface DistManifest {
  buildId: string;
  loader: string;
  plugins: Array<{
    id: string;
    name: string;
    windows: PageWindow[];
    file?: string | null;
    forkGuards?: string[];
    settings?: SettingField[];
  }>;
}

export interface PluginEntry {
  id: string;
  name: string;
  windows: PageWindow[];
  file: string | null;
  settingFields: SettingField[];
  rewrites: ChunkRewrite[];
  task?: PluginManifest["task"];
  enabled: boolean;
  settings: Record<string, unknown>;
}

export class Registry {
  readonly distDir: string;
  readonly buildId: string;
  readonly plugins: PluginEntry[];
  #loader: string;
  #scripts = new Map<PageWindow, string>();

  constructor(distDir: string, buildId: string, loader: string, plugins: PluginEntry[]) {
    this.distDir = distDir;
    this.buildId = buildId;
    this.#loader = loader;
    this.plugins = plugins;
  }

  get(id: string): PluginEntry | undefined {
    return this.plugins.find((p) => p.id === id);
  }

  /** The script injected into a window: window marker, loader, then every plugin for that window. */
  script(window: PageWindow): string {
    const cached = this.#scripts.get(window);
    if (cached !== undefined) return cached;
    const parts = [`globalThis.__cxpWindow = ${JSON.stringify(window)};`, this.#read(this.#loader)];
    for (const p of this.plugins) if (p.file && p.windows.includes(window)) parts.push(this.#read(p.file));
    const script = parts.join("\n");
    this.#scripts.set(window, script);
    return script;
  }

  hasEnabledRewrites(): boolean {
    return this.plugins.some((p) => p.enabled && p.rewrites.length > 0);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.#require(id).enabled = enabled;
    this.#save();
  }

  /** Merges `values` into the plugin's settings, keeping only declared keys of the right type. */
  setSettings(id: string, values: Record<string, unknown>): void {
    const plugin = this.#require(id);
    const fields = plugin.settingFields.filter((f) => f.key in values);
    const invalid = fields.find((f) => !validSetting(f, values[f.key]));
    if (invalid) throw new Error(`invalid value for ${id}.${invalid.key}`);
    for (const f of fields) plugin.settings[f.key] = values[f.key];
    this.#save();
  }

  #read(file: string): string {
    return readFileSync(join(this.distDir, file), "utf8");
  }

  #require(id: string): PluginEntry {
    const plugin = this.get(id);
    if (!plugin) throw new Error(`unknown plugin ${id}`);
    return plugin;
  }

  #save(): void {
    const config: Config = { plugins: {} };
    for (const p of this.plugins) config.plugins[p.id] = { enabled: p.enabled, settings: p.settings };
    writeConfig(config);
  }
}

function validSetting(field: SettingField, value: unknown): boolean {
  switch (field.type) {
    case "text":
      return typeof value === "string";
    case "toggle":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "exclude-list":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
  }
}

export function defaultSettings(fields: SettingField[]): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const f of fields) settings[f.key] = f.type === "exclude-list" ? [...(f.default ?? [])] : f.default;
  return settings;
}

export function readBuildId(distDir: string): string {
  return readFileSync(join(distDir, "build-id"), "utf8").trim();
}

/** Reads dist/, imports each plugin's manifest from `pluginsDir`, and merges the local config. */
export async function loadRegistry(distDir: string, pluginsDir: string): Promise<Registry> {
  const manifest = JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8")) as DistManifest;
  const config = readConfig();
  const plugins: PluginEntry[] = [];
  for (const m of manifest.plugins) {
    const url = pathToFileURL(join(pluginsDir, m.id, "plugin.ts")).href;
    const source = ((await import(url)) as { default: PluginManifest }).default;
    const settingFields = m.settings ?? source.settings ?? [];
    const local = config.plugins[m.id] ?? {};
    plugins.push({
      id: m.id,
      name: m.name,
      windows: m.windows,
      file: m.file ?? null,
      settingFields,
      rewrites: source.rewrites ?? [],
      task: source.task,
      enabled: local.enabled ?? true,
      settings: { ...defaultSettings(settingFields), ...local.settings },
    });
  }
  return new Registry(distDir, readBuildId(distDir), manifest.loader, plugins);
}
