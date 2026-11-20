// Starts and stops each enabled plugin's local task; restarts it when its settings, enabled flag
// or a retry arrive from a page. Task failures are reported to the channel with source "task".

import type { TaskContext } from "../plugins/types.ts";
import { type Channel, errorText, type Log } from "./channel.ts";
import type { PluginEntry, Registry } from "./registry.ts";

interface Running {
  cleanup: (() => void) | null;
  unregister: Array<() => void>;
  stopped: boolean;
}

export function startTasks(registry: Registry, channel: Channel, log: Log = console.log): void {
  const running = new Map<string, Running>();

  const stop = (id: string) => {
    const run = running.get(id);
    if (!run) return;
    running.delete(id);
    run.stopped = true;
    for (const off of run.unregister) off();
    try {
      run.cleanup?.();
    } catch (error) {
      log(`${id}: task cleanup failed:`, errorText(error));
    }
  };

  const start = (plugin: PluginEntry) => {
    const task = plugin.task;
    if (!task || !plugin.enabled) return;
    const id = plugin.id;
    const run: Running = { cleanup: null, unregister: [], stopped: false };
    running.set(id, run);
    const fail = (reason: string) => {
      if (run.stopped) return;
      log(`${id}: task failed: ${reason}`);
      stop(id);
      channel.setStatus(id, "task", "failed", reason);
    };
    const ctx: TaskContext = {
      settings: structuredClone(plugin.settings),
      onRequest: (method, handler) => {
        if (!run.stopped) run.unregister.push(channel.onRequest(id, method, handler));
      },
      fail,
      log: (...args) => log(`${id}:`, ...args),
    };
    try {
      run.cleanup = task(ctx);
      if (run.stopped) run.cleanup(); // it called fail() during start, which ran stop() before cleanup existed
    } catch (error) {
      fail(errorText(error));
    }
  };

  channel.onPluginChange((id, change) => {
    const plugin = registry.get(id);
    if (!plugin?.task) return;
    log(`${id}: ${change}, restarting task`);
    stop(id);
    channel.setStatus(id, "task", null);
    start(plugin);
  });

  for (const plugin of registry.plugins) start(plugin);
}
