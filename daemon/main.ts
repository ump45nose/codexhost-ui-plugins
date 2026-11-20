// Daemon entry: `node daemon/main.ts`. Set CXP_DIST_DIR to inject from another dist directory.

import { readFileSync, watchFile } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpConnection } from "./cdp.ts";
import { Channel } from "./channel.ts";
import { discoveryLoop, findDesktop } from "./desktop.ts";
import { Injector } from "./injector.ts";
import { loadRegistry } from "./registry.ts";

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
const logError = (...args: unknown[]) => console.error(new Date().toISOString(), ...args);

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(process.env.CXP_DIST_DIR ?? join(repoDir, "dist"));

const registry = await loadRegistry(distDir, join(repoDir, "plugins"));
const channel = new Channel(registry, log);
log(`daemon: build ${registry.buildId}, ${registry.plugins.length} plugin(s) from ${distDir}`);

// A new build (auto-update or manual `npm run build`) replaces dist/: exit, launchd starts the new code.
const buildIdFile = join(distDir, "build-id");
watchFile(buildIdFile, { interval: 1000 }, () => {
  let current: string;
  try {
    current = readFileSync(buildIdFile, "utf8").trim();
  } catch {
    return; // dist/ is being swapped
  }
  if (current === registry.buildId) return;
  log(`daemon: build-id changed to ${current}, exiting for restart`);
  process.exit(0);
});

// Local tasks (W1.3) and the updater (W1.4) are wired here:
// startTasks(registry, channel);
// startUpdater(repoDir, channel);

await discoveryLoop({
  find: () => findDesktop(),
  log,
  session: async (endpoint) => {
    const cdp = await CdpConnection.connect(endpoint.browserUrl);
    const injector = new Injector(cdp, channel, log);
    try {
      await injector.start();
      await cdp.closed;
    } finally {
      injector.dispose();
      cdp.close();
    }
  },
}).catch((error) => {
  logError("daemon: fatal:", error);
  process.exit(1);
});
