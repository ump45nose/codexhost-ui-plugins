// Auto-update: every 2 minutes fetch the repo's upstream and, when `main` is checked out, clean and
// fast-forwardable, merge, `npm ci` if the lockfile changed, and run scripts/build.mjs (which swaps
// in a new dist/ only on success). The new dist/build-id makes the daemon exit (main.ts) so launchd
// starts the new code.
// A failed `npm ci` or build resets to the pre-merge commit and is not retried for the same commit.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Channel, Log } from "./channel.ts";

const execFileAsync = promisify(execFile);

export interface UpdaterOptions {
  intervalMs?: number; // default 2 minutes
  npmCi?: string[]; // default ["npm", "ci"]
  build?: string[]; // default: node scripts/build.mjs
  log?: Log;
}

export interface Updater {
  /** Runs one check now (or joins the one in progress). */
  check(): Promise<void>;
  stop(): void;
}

/** Thrown for conditions where the updater skips quietly (logged once until the reason changes). */
class Skip extends Error {}

export function startUpdater(repoDir: string, channel: Pick<Channel, "setUpdate">, options: UpdaterOptions = {}): Updater {
  const intervalMs = options.intervalMs ?? 2 * 60_000;
  const npmCi = options.npmCi ?? ["npm", "ci"];
  const build = options.build ?? [process.execPath, join(repoDir, "scripts", "build.mjs")];
  const log = options.log ?? console.log;
  const run = (command: string[]) => exec(command, repoDir);
  const git = async (...args: string[]) => (await run(["git", ...args])).trim();

  let failed: { commit: string; error: string } | null = null;
  let lastNote: string | null = null;
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const note = (message: string | null) => {
    if (message && message !== lastNote) log(`updater: ${message}`);
    lastNote = message;
  };

  async function update(): Promise<void> {
    const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "main") throw new Skip(`skipping, on ${branch} (not main)`);
    if (await git("status", "--porcelain")) throw new Skip("skipping, working tree has uncommitted changes");
    const upstream = await git("rev-parse", "--abbrev-ref", "@{u}").catch(() => {
      throw new Skip("skipping, main has no upstream branch");
    });
    await git("fetch", "--quiet").catch((error: unknown) => {
      throw new Skip(`git fetch failed: ${reasonOf(error)}`);
    });
    const head = await git("rev-parse", "HEAD");
    const target = await git("rev-parse", "@{u}");
    if (target === head) {
      failed = null;
      return note(null);
    }
    if (failed?.commit === target) return; // already failed; wait for a newer upstream commit
    if (!(await isAncestor(head, target))) throw new Skip(`skipping, main cannot fast-forward to ${upstream}`);

    log(`updater: updating ${short(head)} -> ${short(target)}`);
    await git("merge", "--ff-only", "--quiet", target);
    const lockChanged = await git("diff", "--name-only", head, target, "--", "package-lock.json").then(Boolean);
    let stage = "npm ci";
    try {
      if (lockChanged) await run(npmCi);
      stage = "build";
      await run(build);
    } catch (error) {
      failed = { commit: target, error: `update to ${short(target)} failed (${stage}): ${reasonOf(error)}` };
      log(`updater: ${failed.error}; resetting to ${short(head)}`);
      await git("reset", "--hard", "--quiet", head);
      // npm ci rewrote node_modules for the new lockfile; put back the old dependencies.
      if (lockChanged) await run(npmCi).catch((e: unknown) => log(`updater: restoring dependencies failed: ${reasonOf(e)}`));
      return;
    }
    failed = null;
    note(null);
    log(`updater: updated to ${short(target)}, new dist/ in place`);
  }

  async function isAncestor(ancestor: string, commit: string): Promise<boolean> {
    try {
      await git("merge-base", "--is-ancestor", ancestor, commit);
      return true;
    } catch {
      return false;
    }
  }

  async function tick(): Promise<void> {
    try {
      await update();
    } catch (error) {
      if (error instanceof Skip) note(error.message);
      else note(`check failed: ${reasonOf(error)}`);
    }
    channel.setUpdate({ checkedAt: new Date().toISOString(), ...(failed ? { error: failed.error } : {}) });
  }

  function check(): Promise<void> {
    running ??= tick().finally(() => {
      running = null;
    });
    return running;
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => void check().then(schedule), intervalMs);
  }

  void check().then(schedule);
  return {
    check,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

async function exec(command: string[], cwd: string): Promise<string> {
  const [file, ...args] = command;
  const { stdout } = await execFileAsync(file, args, {
    cwd,
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

/** The useful part of a failed command: its last stderr lines, or the error message. */
function reasonOf(error: unknown): string {
  const e = error as { stderr?: string; killed?: boolean; message?: string };
  if (e.killed) return "timed out";
  const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
  const text = stderr ? stderr.split("\n").slice(-5).join("\n") : (e.message ?? String(error));
  return text.length > 500 ? `...${text.slice(-500)}` : text;
}

const short = (sha: string) => sha.slice(0, 7);
