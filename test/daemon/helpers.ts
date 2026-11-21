import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cdp, CdpHandler, CdpResult } from "../../daemon/cdp.ts";
import { Channel } from "../../daemon/channel.ts";
import { type PluginEntry, Registry } from "../../daemon/registry.ts";
import type { ChunkRewrite } from "../../plugins/types.ts";

export interface Call {
  method: string;
  params: CdpResult;
  sessionId?: string;
}

export class FakeCdp implements Cdp {
  calls: Call[] = [];
  closed = false;
  responders: Record<string, (params: CdpResult, sessionId?: string) => CdpResult> = {};
  #handlers = new Map<string, CdpHandler[]>();

  async send(method: string, params: object = {}, sessionId?: string): Promise<CdpResult> {
    if (this.closed) throw new Error(`CDP connection closed (${method})`);
    this.calls.push({ method, params, sessionId });
    return this.responders[method]?.(params, sessionId) ?? {};
  }

  on(event: string, handler: CdpHandler): void {
    this.#handlers.set(event, [...(this.#handlers.get(event) ?? []), handler]);
  }

  emit(event: string, params: CdpResult, sessionId?: string): void {
    for (const h of this.#handlers.get(event) ?? []) h(params, sessionId);
  }

  close(): void {
    this.closed = true;
  }

  /** Methods sent to a session, without the channel's state pushes. */
  methods(sessionId?: string): string[] {
    return this.calls
      .filter((c) => c.sessionId === sessionId && !String(c.params.expression ?? "").startsWith("window.__cxpReceive"))
      .map((c) => c.method);
  }
}

export function plugin(id: string, extra: Partial<PluginEntry> = {}): PluginEntry {
  return { id, name: id, windows: ["main"], file: null, settingFields: [], rewrites: [], enabled: true, settings: {}, ...extra };
}

export function rule(name: string, identify: (s: string) => boolean, apply: (s: string) => string | null): ChunkRewrite {
  return { name, identify, apply };
}

/** A temp HOME (config writes) and a temp dist with a fixture loader. */
export function setup(plugins: PluginEntry[], buildId = "build-1"): { channel: Channel; registry: Registry; logs: unknown[][] } {
  const root = mkdtempSync(join(tmpdir(), "cxp-test-"));
  process.env.HOME = root;
  writeFileSync(join(root, "loader.js"), "globalThis.__cxpLoaderV1 = {};");
  for (const p of plugins) if (p.file) writeFileSync(join(root, p.file), `/* ${p.id} */`);
  const registry = new Registry(root, buildId, "loader.js", plugins);
  const logs: unknown[][] = [];
  return { channel: new Channel(registry, (...a) => logs.push(a)), registry, logs };
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));
