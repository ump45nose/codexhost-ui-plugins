// Finding Codex Desktop: a process started with --remote-debugging-port=N whose /json/list has
// an `app://-/index.html` page (other Chromium processes with debugging ports are ignored).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Log } from "./channel.ts";

export interface Endpoint {
  port: number;
  browserUrl: string;
}

export interface DiscoveryDeps {
  processArgs(): Promise<string>;
  fetchJson(url: string): Promise<unknown>;
}

const run = promisify(execFile);

export const systemDeps: DiscoveryDeps = {
  async processArgs() {
    return (await run("ps", ["-axww", "-o", "args="], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  },
  async fetchJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  },
};

export function debuggingPorts(psOutput: string): number[] {
  const ports = new Set<number>();
  for (const match of psOutput.matchAll(/--remote-debugging-port=(\d+)/g)) {
    const port = Number(match[1]);
    if (port > 0) ports.add(port);
  }
  return [...ports];
}

export async function findDesktop(deps: DiscoveryDeps = systemDeps): Promise<Endpoint | null> {
  for (const port of debuggingPorts(await deps.processArgs())) {
    try {
      const targets = (await deps.fetchJson(`http://127.0.0.1:${port}/json/list`)) as Array<{ type?: string; url?: string }>;
      if (!targets.some((t) => t.type === "page" && t.url?.startsWith("app://-/index.html"))) continue;
      const version = (await deps.fetchJson(`http://127.0.0.1:${port}/json/version`)) as { webSocketDebuggerUrl?: string };
      if (version.webSocketDebuggerUrl) return { port, browserUrl: version.webSocketDebuggerUrl };
    } catch {
      // Not answering (starting up, or not a DevTools endpoint): try the next port.
    }
  }
  return null;
}

/**
 * Finds Desktop every `intervalMs` and runs `session` against it; `session` resolves when the
 * connection ends, after which discovery starts again (Desktop restarts on a new port).
 */
export async function discoveryLoop(opts: {
  find: () => Promise<Endpoint | null>;
  session: (endpoint: Endpoint) => Promise<void>;
  log: Log;
  intervalMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const interval = opts.intervalMs ?? 3000;
  let waiting = false;
  while (!opts.signal?.aborted) {
    let endpoint: Endpoint | null = null;
    try {
      endpoint = await opts.find();
    } catch (error) {
      opts.log("desktop: discovery failed:", error instanceof Error ? error.message : error);
    }
    if (!endpoint) {
      if (!waiting) opts.log("desktop: waiting for Codex Desktop with a debugging port");
      waiting = true;
      await new Promise((resolve) => setTimeout(resolve, interval));
      continue;
    }
    waiting = false;
    opts.log(`desktop: found on port ${endpoint.port}`);
    try {
      await opts.session(endpoint);
      opts.log(`desktop: disconnected from port ${endpoint.port}`);
    } catch (error) {
      opts.log(`desktop: session on port ${endpoint.port} failed:`, error instanceof Error ? error.message : error);
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}
