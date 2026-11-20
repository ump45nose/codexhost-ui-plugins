// Copies Codex's user instructions (`~/.codex/AGENTS.override.md`, else `~/.codex/AGENTS.md`) to
// every installed Harness's global instruction file. Ported from the codexhost fork
// (packages/host-runtime/src/harness-user-instructions.ts) without zod or codexhost contracts.

import { createHash, randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TaskContext } from "../types.ts";

/** Harness name, its config root (exists = installed) and its instruction file, relative to HOME. */
const TARGETS: ReadonlyArray<readonly [name: string, root: string, file: string]> = [
  ["antigravity", ".gemini", ".gemini/GEMINI.md"],
  ["claude-code", ".claude", ".claude/CLAUDE.md"],
  ["codebuddy", ".codebuddy", ".codebuddy/CODEBUDDY.md"],
  ["copilot", ".copilot", ".copilot/copilot-instructions.md"],
  ["cursor-cli", ".cursor", ".cursor/AGENTS.md"],
  ["deepseek-harness", ".dsh", ".dsh/AGENTS.md"],
  ["devin", ".devin", ".devin/AGENTS.md"],
  ["grok", ".grok", ".grok/AGENTS.md"],
  ["hermes", ".hermes", ".hermes/AGENTS.md"],
  ["kimi-code", ".kimi-code", ".kimi-code/AGENTS.md"],
  ["kiro-cli", ".kiro", ".kiro/steering/AGENTS.md"],
  ["omp", ".omp", ".omp/agent/AGENTS.md"],
  ["opencode", ".config/opencode", ".config/opencode/AGENTS.md"],
  ["pi", ".pi", ".pi/agent/AGENTS.md"],
  ["qoder", ".qoder", ".qoder/AGENTS.md"],
  ["qoder-cn", ".qoder-cn", ".qoder-cn/AGENTS.md"],
  ["qwen-code", ".qwen", ".qwen/QWEN.md"],
  ["workbuddy", ".workbuddy-ai", ".workbuddy-ai/WORKBUDDY.md"],
  ["zcode", ".zcode", ".zcode/AGENTS.md"],
];

export const HARNESS_NAMES: string[] = TARGETS.map(([name]) => name);

/**
 * One file per Harness, `<name>.json`, same shape as the fork's manifest: the content the target
 * had before we first wrote it (or that it did not exist), and the digest of what we last wrote,
 * so a later manual edit of the target is recognised and saved before being overwritten.
 */
interface Backup {
  hadOriginal: boolean;
  originalContent?: string;
  syncedDigest: string;
  targetPath: string;
}

const SOURCE_DEBOUNCE_MS = 300;

export function backupDir(home = homedir()): string {
  return join(home, ".config", "codexhost-ui-plugins", "instruction-backups");
}

/** The Codex instructions to distribute, or null when neither file has content. */
export async function readSource(home = homedir()): Promise<string | null> {
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    const content = await readOptional(join(home, ".codex", name));
    if (content !== null && content.trim().length > 0) return content;
  }
  return null;
}

/** Syncs every installed, non-excluded Harness. Returns the names whose file was written. */
export async function syncInstructions(exclude: ReadonlySet<string>, home = homedir()): Promise<string[]> {
  const content = await readSource(home);
  if (content === null) return [];
  const written: string[] = [];
  const errors: string[] = [];
  for (const [name, root, file] of TARGETS) {
    if (exclude.has(name)) continue;
    try {
      if (await syncTarget(name, join(home, root), join(home, file), content, home)) written.push(name);
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
  return written;
}

async function syncTarget(name: string, rootDir: string, filePath: string, content: string, home: string): Promise<boolean> {
  const backupPath = join(backupDir(home), `${name}.json`);
  const backup = await readBackup(backupPath);
  if (!backup && !(await isDirectory(rootDir))) return false; // not installed
  // Write through symlinks (dotfile setups) instead of replacing the link with a file.
  const target = await realpath(filePath).catch(() => filePath);
  const current = await readOptional(target);
  const nextDigest = digest(content);
  if (!backup) {
    await writeBackup(backupPath, current === null
      ? { hadOriginal: false, syncedDigest: nextDigest, targetPath: filePath }
      : { hadOriginal: true, originalContent: current, syncedDigest: nextDigest, targetPath: filePath });
  } else if (current !== null && current !== content && digest(current) !== backup.syncedDigest) {
    // Edited by hand since our last write: keep that edit as the original.
    await writeBackup(backupPath, { hadOriginal: true, originalContent: current, syncedDigest: nextDigest, targetPath: filePath });
  } else if (backup.syncedDigest !== nextDigest) {
    await writeBackup(backupPath, { ...backup, syncedDigest: nextDigest });
  }
  if (current === content) return false;
  await atomicWrite(target, content);
  return true;
}

/** Local task: sync now, then on every change in `~/.codex`. */
export function startInstructionSync(ctx: TaskContext): () => void {
  const exclude = new Set(Array.isArray(ctx.settings.exclude) ? (ctx.settings.exclude as string[]) : []);
  const codexDir = join(homedir(), ".codex");
  let stopped = false;
  let running = false;
  let pending = false;
  let timer: NodeJS.Timeout | undefined;

  const run = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        const written = await syncInstructions(exclude);
        if (written.length > 0 && !stopped) ctx.log(`synced to ${written.join(", ")}`);
      } while (pending && !stopped);
    } catch (error) {
      if (!stopped) ctx.fail(`instruction sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };

  // Watch the directory, not the file: editors and Codex replace the file, or create it later.
  let watcher: FSWatcher;
  try {
    watcher = watch(codexDir, (_event, file) => {
      if (file !== null && file !== "AGENTS.md" && file !== "AGENTS.override.md") return;
      clearTimeout(timer);
      timer = setTimeout(() => void run(), SOURCE_DEBOUNCE_MS);
    });
  } catch (error) {
    throw new Error(`cannot watch ${codexDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  watcher.on("error", (error) => {
    if (!stopped) ctx.fail(`watching ${codexDir} failed: ${error.message}`);
  });
  void run();

  return () => {
    stopped = true;
    clearTimeout(timer);
    watcher.close();
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** A backup that exists but can't be parsed throws: it may hold the user's only original. */
async function readBackup(path: string): Promise<Backup | null> {
  const raw = await readOptional(path);
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as Partial<Backup>;
  if (typeof parsed.hadOriginal !== "boolean" || typeof parsed.syncedDigest !== "string") {
    throw new Error(`unreadable backup ${path}`);
  }
  return parsed as Backup;
}

async function writeBackup(path: string, backup: Backup): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(backup)}\n`);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${randomUUID()}.tmp`);
  const mode = await stat(path).then((s) => s.mode & 0o777, () => 0o600); // keep an existing file's mode
  const handle = await open(temp, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
