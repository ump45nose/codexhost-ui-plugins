// Plugin contracts shared by the daemon (imported via Node type stripping) and the page loader.

export interface PluginManifest {
  id: string;
  name: string;
  windows: Array<"main" | "pet">;
  page?: string;
  forkGuards?: string[];
  rewrites?: ChunkRewrite[];
  task?: (ctx: TaskContext) => () => void;
  settings?: SettingField[];
}

export interface ChunkRewrite {
  name: string;
  identify(source: string): boolean;
  apply(source: string): string | null;
}

export type SettingField =
  | { key: string; type: "text"; label: string; default: string }
  | { key: string; type: "toggle"; label: string; default: boolean }
  | { key: string; type: "number"; label: string; default: number; min?: number; max?: number; step?: number }
  | { key: string; type: "exclude-list"; label: string; options: string[]; default?: string[] };

export interface TaskContext {
  settings: Record<string, unknown>;
  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void;
  fail(reason: string): void;
  log(...args: unknown[]): void;
}

export interface PluginApi {
  id: string;
  window: "main" | "pet";
  settings: Record<string, unknown>;
  request(method: string, params?: unknown): Promise<unknown>;
  fail(reason: string): void;
  log(...args: unknown[]): void;
}

export type PluginStatus = "active" | "dormant" | "failed" | "off";
