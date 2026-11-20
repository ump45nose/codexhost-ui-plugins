import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UpdateState } from "../../daemon/channel.ts";
import { startUpdater, type Updater, type UpdaterOptions } from "../../daemon/updater.ts";

const projectRoot = resolve(import.meta.dirname, "../..");
const root = mkdtempSync(join(tmpdir(), "cxp-updater-"));
let counter = 0;

// Isolate git from the user's config (signing, hooks, default branch).
beforeAll(() => {
  writeFileSync(join(root, "gitconfig"), "[user]\n\tname = test\n\temail = test@example.com\n");
  process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// Fake build: fails when build.txt says "fail", otherwise writes the short SHA as build-id.
const fakeBuild = join(root, "fake-build.mjs");
writeFileSync(
  fakeBuild,
  `import fs from "node:fs"; import { execFileSync } from "node:child_process";
const out = process.argv[2];
if (fs.readFileSync("build.txt", "utf8").trim() === "fail") { console.error("boom: build broken"); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(out + "/build-id", execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim());
`,
);

interface Fixture {
  seed: string; // pushes new commits to the remote
  local: string; // the updater's repo, a clone on main
  updates: UpdateState[];
  logs: string[];
  builds: number;
  push(files: Record<string, string>): string;
  start(options?: UpdaterOptions): Updater;
  buildId(): string;
}

function fixture(populate?: (seed: string) => void): Fixture {
  const dir = join(root, `case-${++counter}`);
  const remote = join(dir, "remote.git");
  const seed = join(dir, "seed");
  const local = join(dir, "local");
  mkdirSync(seed, { recursive: true });
  git(dir, "init", "--quiet", "--bare", "-b", "main", remote);
  git(seed, "init", "--quiet", "-b", "main");
  writeFileSync(join(seed, ".gitignore"), "node_modules\ndist/\n.dist-*/\n");
  writeFileSync(join(seed, "build.txt"), "ok\n");
  writeFileSync(join(seed, "package-lock.json"), "{}\n");
  populate?.(seed);
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "initial");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "--quiet", "-u", "origin", "main");
  git(dir, "clone", "--quiet", remote, local);
  mkdirSync(join(local, "dist"));
  writeFileSync(join(local, "dist", "build-id"), "old");

  const f: Fixture = {
    seed,
    local,
    updates: [],
    logs: [],
    builds: 0,
    push(files) {
      for (const [name, content] of Object.entries(files)) writeFileSync(join(seed, name), content);
      git(seed, "commit", "--quiet", "-am", `change ${Object.keys(files).join(",")}`);
      git(seed, "push", "--quiet");
      return git(seed, "rev-parse", "HEAD");
    },
    start(options = {}) {
      return startUpdater(
        local,
        { setUpdate: (u) => f.updates.push(u) },
        {
          intervalMs: 3_600_000,
          npmCi: ["true"],
          build: (out) => {
            f.builds++;
            return [process.execPath, fakeBuild, out];
          },
          log: (...args) => f.logs.push(args.join(" ")),
          ...options,
        },
      );
    },
    buildId: () => readFileSync(join(local, "dist", "build-id"), "utf8"),
  };
  return f;
}

describe("updater", () => {
  it("fast-forwards main, builds and swaps dist/ when the remote has a new commit", async () => {
    const f = fixture();
    const target = f.push({ "build.txt": "ok 2\n" });
    const u = f.start();
    await u.check();
    u.stop();
    expect(git(f.local, "rev-parse", "HEAD")).toBe(target);
    expect(f.buildId()).toBe(target.slice(0, 7));
    expect(f.updates.at(-1)).toEqual({ checkedAt: expect.any(String) });
    expect(readdirSync(f.local).filter((n) => n.startsWith(".dist-"))).toEqual([]);
  });

  it("runs npm ci only when package-lock.json changed", async () => {
    const f = fixture();
    const marker = join(root, `npm-ci-${counter}`);
    const npmCi = [process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(marker)}, "x")`];
    f.push({ "build.txt": "ok 2\n" });
    const u = f.start({ npmCi });
    await u.check();
    expect(existsSync(marker)).toBe(false);
    f.push({ "package-lock.json": '{"v":2}\n' });
    await u.check();
    u.stop();
    expect(readFileSync(marker, "utf8")).toBe("x");
  });

  it("builds with the real scripts/build.mjs", async () => {
    const f = fixture((seed) => {
      execFileSync("sh", ["-c", `git -C "${projectRoot}" archive HEAD | tar -x -C "${seed}"`]);
    });
    symlinkSync(join(projectRoot, "node_modules"), join(f.local, "node_modules"));
    appendFileSync(join(f.local, ".git", "info", "exclude"), "node_modules\n"); // the repo ignores only node_modules/ dirs
    const target = f.push({ "build.txt": "ok 2\n" });
    const u = f.start({ build: undefined });
    await u.check();
    u.stop();
    expect(f.logs).toEqual([expect.stringContaining("updater: updating"), expect.stringContaining("updater: updated to")]);
    expect(f.buildId()).toBe(target.slice(0, 7));
    const manifest = JSON.parse(readFileSync(join(f.local, "dist", "manifest.json"), "utf8"));
    expect(manifest.buildId).toBe(target.slice(0, 7));
    expect(existsSync(join(f.local, "dist", "loader.js"))).toBe(true);
  }, 60_000);

  it("skips quietly when not on main", async () => {
    const f = fixture();
    git(f.local, "checkout", "--quiet", "-b", "feature");
    const before = git(f.local, "rev-parse", "HEAD");
    f.push({ "build.txt": "ok 2\n" });
    const u = f.start();
    await u.check();
    await u.check();
    u.stop();
    expect(git(f.local, "rev-parse", "HEAD")).toBe(before);
    expect(f.buildId()).toBe("old");
    expect(f.updates).toEqual([{ checkedAt: expect.any(String) }, { checkedAt: expect.any(String) }]);
    expect(f.logs).toEqual(["updater: skipping, on feature (not main)"]); // logged once
  });

  it("skips quietly when the working tree is dirty", async () => {
    const f = fixture();
    const before = git(f.local, "rev-parse", "HEAD");
    writeFileSync(join(f.local, "scratch.txt"), "wip");
    f.push({ "build.txt": "ok 2\n" });
    const u = f.start();
    await u.check();
    u.stop();
    expect(git(f.local, "rev-parse", "HEAD")).toBe(before);
    expect(f.buildId()).toBe("old");
    expect(f.builds).toBe(0);
    expect(f.updates.at(-1)).toEqual({ checkedAt: expect.any(String) });
    expect(f.logs.join("\n")).toContain("uncommitted changes");
  });

  it("skips quietly when main cannot fast-forward", async () => {
    const f = fixture();
    writeFileSync(join(f.local, "local.txt"), "local");
    git(f.local, "add", "-A");
    git(f.local, "commit", "--quiet", "-m", "local");
    const before = git(f.local, "rev-parse", "HEAD");
    f.push({ "build.txt": "ok 2\n" });
    const u = f.start();
    await u.check();
    u.stop();
    expect(git(f.local, "rev-parse", "HEAD")).toBe(before);
    expect(f.builds).toBe(0);
    expect(f.logs.join("\n")).toContain("cannot fast-forward");
  });

  it("a failing build keeps dist/, resets, reports the error and does not retry the same commit", async () => {
    const f = fixture();
    const before = git(f.local, "rev-parse", "HEAD");
    const bad = f.push({ "build.txt": "fail\n" });
    const u = f.start();
    await u.check();
    expect(git(f.local, "rev-parse", "HEAD")).toBe(before);
    expect(git(f.local, "status", "--porcelain")).toBe("");
    expect(f.buildId()).toBe("old");
    const error = f.updates.at(-1)?.error ?? "";
    expect(error).toContain(bad.slice(0, 7));
    expect(error).toContain("build");
    expect(error).toContain("boom: build broken");
    expect(f.builds).toBe(1);

    await u.check(); // same remote commit: no retry, error stays
    expect(f.builds).toBe(1);
    expect(git(f.local, "rev-parse", "HEAD")).toBe(before);
    expect(f.updates.at(-1)).toEqual({ checkedAt: expect.any(String), error });

    const fixed = f.push({ "build.txt": "ok again\n" }); // newer commit: retried
    await u.check();
    u.stop();
    expect(f.builds).toBe(2);
    expect(f.buildId()).toBe(fixed.slice(0, 7));
    expect(f.updates.at(-1)).toEqual({ checkedAt: expect.any(String) });
  });

  it("checks again every interval", async () => {
    const f = fixture();
    const u = f.start({ intervalMs: 20 });
    await expect.poll(() => f.updates.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(3);
    u.stop();
  });
});

