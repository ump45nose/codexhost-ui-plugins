import { describe, expect, it } from "vitest";
import { startTasks } from "../../daemon/tasks.ts";
import type { TaskContext } from "../../plugins/types.ts";
import { plugin, setup, tick } from "../daemon/helpers.ts";

const field = { key: "dir", type: "text" as const, label: "Dir", default: "" };

function withPage(channel: ReturnType<typeof setup>["channel"]) {
  const sent: any[] = [];
  channel.addPage("s1", "main", async (expr) => {
    sent.push(JSON.parse(expr.slice("window.__cxpReceive?.(".length, -1)));
  });
  return {
    sent,
    send: (msg: object) => channel.handleBinding("s1", JSON.stringify(msg)),
  };
}

describe("startTasks", () => {
  it("fails a task that throws on start (source task) and still runs the others", async () => {
    const started: string[] = [];
    const { channel } = setup([
      plugin("bad", { task: () => { throw new Error("boom"); } }),
      plugin("good", { task: () => (started.push("good"), () => {}) }),
    ]);
    startTasks(channel.registry, channel, () => {});
    await tick();
    expect(channel.aggregate("bad")).toEqual({ status: "failed", source: "task", reason: "boom" });
    expect(channel.aggregate("good")).toEqual({ status: "active" });
    expect(started).toEqual(["good"]);
  });

  it("restarts a task with new settings and moves its request handlers", async () => {
    const seen: unknown[] = [];
    let cleanups = 0;
    const task = (ctx: TaskContext) => {
      seen.push(ctx.settings.dir);
      ctx.onRequest("get", async () => ctx.settings.dir);
      return () => void cleanups++;
    };
    const { channel } = setup([plugin("p", { task, settingFields: [field], settings: { dir: "a" } })]);
    const logs: unknown[][] = [];
    startTasks(channel.registry, channel, (...a) => logs.push(a));
    const page = withPage(channel);
    page.send({ type: "settings:set", plugin: "p", values: { dir: "b" } });
    expect(seen).toEqual(["a", "b"]);
    expect(cleanups).toBe(1);
    page.send({ type: "request", id: 1, plugin: "p", method: "get" });
    await tick();
    await tick();
    expect(page.sent.find((m) => m.type === "response")).toEqual({ type: "response", id: 1, result: "b" });
    expect(logs.some((l) => String(l[0]).startsWith("p:"))).toBe(true);
  });

  it("ctx.fail stops the task; retry starts it again; disabling stops it", async () => {
    let ctxRef: TaskContext | undefined;
    let starts = 0;
    let cleanups = 0;
    const { channel } = setup([plugin("p", { task: (ctx) => ((ctxRef = ctx), starts++, () => void cleanups++) })]);
    startTasks(channel.registry, channel, () => {});
    ctxRef!.fail("broken");
    expect(channel.aggregate("p")).toMatchObject({ status: "failed", source: "task", reason: "broken" });
    expect(cleanups).toBe(1);
    const page = withPage(channel);
    page.send({ type: "retry", plugin: "p" });
    expect(starts).toBe(2);
    expect(channel.aggregate("p")).toEqual({ status: "active" });
    page.send({ type: "enable", plugin: "p", enabled: false });
    expect(cleanups).toBe(2);
    expect(starts).toBe(2);
  });
});
