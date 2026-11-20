// Local config `~/.config/codexhost-ui-plugins/config.json`. The daemon is the only writer.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PluginConfig {
  enabled?: boolean;
  settings?: Record<string, unknown>;
}

export interface Config {
  plugins: Record<string, PluginConfig>;
}

export function configPath(): string {
  return join(homedir(), ".config", "codexhost-ui-plugins", "config.json");
}

/** Missing file → empty config. A file that isn't valid JSON throws: it is the user's data. */
export function readConfig(): Config {
  let text: string;
  try {
    text = readFileSync(configPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { plugins: {} };
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<Config>;
  return { plugins: parsed.plugins && typeof parsed.plugins === "object" ? parsed.plugins : {} };
}

export function writeConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temp, path);
}
