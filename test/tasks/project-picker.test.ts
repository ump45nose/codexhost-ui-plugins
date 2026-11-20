import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLE_ID, pickerTask, type RunScript } from "../../plugins/project-picker/task.ts";
import type { TaskContext } from "../../plugins/types.ts";

function fake(out = "ok") {
  const calls: string[][] = [];
  const run: RunScript = async (script, args) => {
    expect(script).toContain("NSOSPLastRootDirectory");
    expect(script).toContain("NSNavLastRootDirectory");
    calls.push(args);
    return `${out}\n`;
  };
  return { calls, run };
}

function start(run: RunScript, defaultDirectory: string) {
  const handlers = new Map<string, (p: unknown) => Promise<unknown>>();
  const failures: string[] = [];
  const ctx: TaskContext = {
    settings: { defaultDirectory },
    onRequest: (m, h) => void handlers.set(m, h),
    fail: (r) => failures.push(r),
    log: () => {},
  };
  pickerTask(run)(ctx);
  return { handlers, failures };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("project-picker task (C1.7)", () => {
  it("writes the preferences at start and on applyDefaultDirectory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cxp-pp-"));
    const { calls, run } = fake();
    const { handlers, failures } = start(run, dir);
    await settle();
    expect(calls).toEqual([[dir, BUNDLE_ID]]);
    expect(await handlers.get("applyDefaultDirectory")!(undefined)).toEqual({ directory: dir });
    expect(calls.length).toBe(2);
    expect(failures).toEqual([]);
  });

  it("writes nothing when the setting is empty", async () => {
    const { calls, run } = fake();
    const { handlers, failures } = start(run, "");
    await settle();
    expect(await handlers.get("applyDefaultDirectory")!(undefined)).toEqual({ directory: null });
    expect(calls).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("fails for a missing directory or a script that does not report ok", async () => {
    const missing = start(fake().run, "/nonexistent/cxp-dir");
    const broken = start(fake("bookmark failed").run, tmpdir());
    await settle();
    expect(missing.failures[0]).toMatch(/not a directory/);
    expect(broken.failures[0]).toMatch(/bookmark failed/);
  });
});
