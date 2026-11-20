import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import manifest from "../../plugins/harness-instructions/plugin.ts";
import type { TaskContext } from "../../plugins/types.ts";

let home: string;
let stop: (() => void) | undefined;
const realHome = process.env.HOME;

function put(rel: string, content: string) {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), content);
}
const read = (rel: string) => readFileSync(join(home, rel), "utf8");

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function run(exclude: string[]) {
  const failures: string[] = [];
  const ctx: TaskContext = {
    settings: { exclude },
    onRequest: () => {},
    fail: (reason) => failures.push(reason),
    log: () => {},
  };
  stop = manifest.task!(ctx);
  return failures;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cxp-hi-"));
  process.env.HOME = home;
});
afterEach(() => {
  stop?.();
  stop = undefined;
  process.env.HOME = realHome;
});

describe("harness-instructions (C1.6)", () => {
  it("syncs installed Harnesses within 5 s of an edit, backs up originals, skips excluded", async () => {
    put(".codex/AGENTS.md", "v1\n");
    put(".claude/CLAUDE.md", "claude original\n");
    mkdirSync(join(home, ".gemini")); // installed, no file yet
    put(".cursor/AGENTS.md", "cursor own\n"); // excluded
    const failures = run(["cursor-cli"]);

    await until(() => existsSync(join(home, ".gemini/GEMINI.md")) && read(".claude/CLAUDE.md") === "v1\n");
    const backups = join(home, ".config/codexhost-ui-plugins/instruction-backups");
    expect(JSON.parse(readFileSync(join(backups, "claude-code.json"), "utf8"))).toMatchObject({
      hadOriginal: true,
      originalContent: "claude original\n",
      targetPath: join(home, ".claude/CLAUDE.md"),
    });
    expect(JSON.parse(readFileSync(join(backups, "antigravity.json"), "utf8"))).toMatchObject({ hadOriginal: false });

    // Editors replace the file: write a temp file and rename it over the source.
    put(".codex/AGENTS.md.tmp", "v2\n");
    const { renameSync } = await import("node:fs");
    renameSync(join(home, ".codex/AGENTS.md.tmp"), join(home, ".codex/AGENTS.md"));
    const t0 = Date.now();
    await until(() => read(".claude/CLAUDE.md") === "v2\n" && read(".gemini/GEMINI.md") === "v2\n");
    expect(Date.now() - t0).toBeLessThan(5000);

    // The backup still holds the first original, not v1.
    expect(JSON.parse(readFileSync(join(backups, "claude-code.json"), "utf8")).originalContent).toBe("claude original\n");
    expect(read(".cursor/AGENTS.md")).toBe("cursor own\n");
    expect(existsSync(join(backups, "cursor-cli.json"))).toBe(false);
    expect(existsSync(join(home, ".qwen"))).toBe(false); // not installed, not created

    // An uninstalled Harness is neither written nor recreated.
    rmSync(join(home, ".gemini"), { recursive: true });
    put(".codex/AGENTS.md", "v3\n");
    await until(() => read(".claude/CLAUDE.md") === "v3\n");
    expect(existsSync(join(home, ".gemini"))).toBe(false);
    expect(failures).toEqual([]);
  });

  it("prefers AGENTS.override.md and picks it up when it is created later", async () => {
    put(".codex/AGENTS.md", "base\n");
    mkdirSync(join(home, ".claude"));
    run([]);
    await until(() => existsSync(join(home, ".claude/CLAUDE.md")) && read(".claude/CLAUDE.md") === "base\n");
    put(".codex/AGENTS.override.md", "override\n");
    await until(() => read(".claude/CLAUDE.md") === "override\n");
  });

  it("fails when ~/.codex does not exist", () => {
    expect(() => run([])).toThrow(/ENOENT/);
  });
});
