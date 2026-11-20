// Points Desktop's folder picker at `defaultDirectory` by writing its macOS open-panel preferences
// (`com.openai.codex`: NSOSPLastRootDirectory as a bookmark, NSNavLastRootDirectory as a path).
// Ported from the codexhost fork (packages/desktop-control/src/macos-open-panel-default-dir.ts).

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { TaskContext } from "../types.ts";

export const BUNDLE_ID = "com.openai.codex";

// The bookmark needs Foundation, which `defaults write` can't produce; JXA writes both keys.
export const SET_OPEN_PANEL_ROOT_SCRIPT = `
ObjC.import("Foundation");
function run(argv) {
  var url = $.NSURL.fileURLWithPathIsDirectory($(argv[0]), true);
  var bookmark = url.bookmarkDataWithOptionsIncludingResourceValuesForKeysRelativeToURLError(0, $(), $(), Ref());
  if (!bookmark || bookmark.isNil()) return "bookmark failed";
  var defaults = $.NSUserDefaults.alloc.initWithSuiteName($(argv[1]));
  defaults.setObjectForKey(bookmark, $("NSOSPLastRootDirectory"));
  defaults.setObjectForKey($(argv[0]), $("NSNavLastRootDirectory"));
  defaults.synchronize;
  return "ok";
}
`.trim();

/** Runs the JXA script with `[directory, bundleId]` and returns its stdout. */
export type RunScript = (script: string, args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

export const runOsascript: RunScript = async (script, args) => {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, ...args], {
    timeout: 5_000,
  });
  return stdout;
};

/** Writes the preferences for `setting` (empty → nothing). Returns the directory written, or null. */
export async function applyDefaultDirectory(setting: string, run: RunScript = runOsascript): Promise<string | null> {
  const raw = setting.trim();
  if (raw === "") return null;
  const dir = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : resolve(raw);
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`default directory ${dir} is not a directory`);
  const out = (await run(SET_OPEN_PANEL_ROOT_SCRIPT, [dir, BUNDLE_ID])).trim();
  if (out !== "ok") throw new Error(`writing ${BUNDLE_ID} open-panel preferences failed: ${out || "no output"}`);
  return dir;
}

/** Local task: write once at start, and again whenever the page asks before opening the picker. */
export function pickerTask(run: RunScript = runOsascript): (ctx: TaskContext) => () => void {
  return (ctx) => {
    const setting = typeof ctx.settings.defaultDirectory === "string" ? ctx.settings.defaultDirectory : "";
    let stopped = false;
    ctx.onRequest("applyDefaultDirectory", async () => ({ directory: await applyDefaultDirectory(setting, run) }));
    applyDefaultDirectory(setting, run).then(
      (dir) => {
        if (dir && !stopped) ctx.log(`default directory set to ${dir}`);
      },
      (error) => {
        if (!stopped) ctx.fail(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      stopped = true;
    };
  };
}
