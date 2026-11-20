import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plugin, setup, tick } from "./helpers.ts";

function page(channel: ReturnType<typeof setup>["channel"], sid: string, window: "main" | "pet" = "main") {
  const sent: unknown[] = [];
  channel.addPage(sid, window, async (expr) => {
    sent.push(JSON.parse(expr.slice("window.__cxpReceive?.(".length, -1)));
  });
  const send = (msg: object) => channel.handleBinding(sid, JSON.stringify(msg));
  return { sent, send, last: () => sent.at(-1) as any };
}

describe("channel", () => {
  it("pushes state after hello with merged settings and status", async () => {
    const { channel } = setup([plugin("a", { settingFields: [{ key: "dir", type: "text", label: "Dir", default: "" }], settings: { dir: "" } })]);
    const p = page(channel, "s1");
    p.send({ type: "hello", window: "main", buildId: "build-1", focused: true });
    await tick();
    expect(p.last()).toEqual({
      type: "state",
      buildId: "build-1",
      plugins: [{ id: "a", name: "a", enabled: true, settings: { dir: "" }, settingFields: expect.any(Array), status: "active" }],
      update: { checkedAt: null },
    });
  });

  it("a page reporting active never overrides a rewriter failure", async () => {
    const { channel } = setup([plugin("pet", { windows: ["pet"] }), plugin("other")]);
    const p = page(channel, "s1", "pet");
    p.send({ type: "hello", window: "pet", buildId: "build-1", focused: false });
    channel.setStatus("pet", "rewriter", "failed", "rule x");
    p.send({ type: "status", plugin: "pet", state: "active" });
    p.send({ type: "status", plugin: "other", state: "active" });
    expect(channel.aggregate("pet")).toEqual({ status: "failed", source: "rewriter", reason: "rule x" });
    expect(channel.aggregate("other")).toEqual({ status: "active" });
    // A page failure shows with the page's window as source; a daemon source still wins.
    p.send({ type: "status", plugin: "pet", state: "failed", reason: "page broke" });
    expect(channel.aggregate("pet").source).toBe("rewriter");
    channel.setStatus("pet", "rewriter", null);
    expect(channel.aggregate("pet")).toEqual({ status: "failed", source: "pet", reason: "page broke" });
    // A new document (hello) forgets what the old one reported.
    p.send({ type: "hello", window: "pet", buildId: "build-1", focused: false });
    expect(channel.aggregate("pet")).toEqual({ status: "active" });
  });

  it("dormant only when no page is active; disabled is off", () => {
    const { channel } = setup([plugin("a")]);
    const p1 = page(channel, "s1");
    const p2 = page(channel, "s2");
    p1.send({ type: "status", plugin: "a", state: "dormant" });
    expect(channel.aggregate("a").status).toBe("dormant");
    p2.send({ type: "status", plugin: "a", state: "active" });
    expect(channel.aggregate("a").status).toBe("active");
    channel.removePage("s2");
    expect(channel.aggregate("a").status).toBe("dormant");
    p1.send({ type: "enable", plugin: "a", enabled: false });
    expect(channel.aggregate("a").status).toBe("off");
  });

  it("settings:set merges partially, validates, and writes the config", async () => {
    const fields = [
      { key: "dir", type: "text" as const, label: "Dir", default: "" },
      { key: "on", type: "toggle" as const, label: "On", default: true },
    ];
    const { channel, registry } = setup([plugin("a", { settingFields: fields, settings: { dir: "", on: true } })]);
    const changes: string[] = [];
    channel.onPluginChange((id, change) => changes.push(`${id}:${change}`));
    const p = page(channel, "s1");
    p.send({ type: "settings:set", plugin: "a", values: { dir: "/tmp/x", unknown: 1 } });
    p.send({ type: "settings:set", plugin: "a", values: { on: "yes" } }); // rejected
    p.send({ type: "enable", plugin: "a", enabled: false });
    expect(registry.get("a")?.settings).toEqual({ dir: "/tmp/x", on: true });
    expect(changes).toEqual(["a:settings", "a:enabled"]);
    const config = JSON.parse(readFileSync(join(process.env.HOME!, ".config/codexhost-ui-plugins/config.json"), "utf8"));
    expect(config).toEqual({ plugins: { a: { enabled: false, settings: { dir: "/tmp/x", on: true } } } });
  });

  it("serves requests through registered handlers and reports errors", async () => {
    const { channel } = setup([plugin("a")]);
    channel.onRequest("a", "echo", async (params) => ({ got: params }));
    channel.onRequest("a", "boom", async () => {
      throw new Error("nope");
    });
    const p = page(channel, "s1");
    p.send({ type: "request", id: 1, plugin: "a", method: "echo", params: 5 });
    p.send({ type: "request", id: 2, plugin: "a", method: "boom" });
    p.send({ type: "request", id: 3, plugin: "a", method: "missing" });
    await tick();
    expect(p.sent).toContainEqual({ type: "response", id: 1, result: { got: 5 } });
    expect(p.sent).toContainEqual({ type: "response", id: 2, error: "nope" });
    expect(p.sent).toContainEqual({ type: "response", id: 3, error: "no handler for a.missing" });
  });

  it("retry clears a task failure and notifies listeners; update state is pushed", async () => {
    const { channel } = setup([plugin("a")]);
    const changes: string[] = [];
    channel.onPluginChange((id, change) => changes.push(`${id}:${change}`));
    channel.setStatus("a", "task", "failed", "disk full");
    const p = page(channel, "s1");
    p.send({ type: "retry", plugin: "a" });
    expect(channel.aggregate("a").status).toBe("active");
    expect(changes).toEqual(["a:retry"]);
    channel.setUpdate({ checkedAt: "2026-11-20T00:00:00Z", error: "build failed" });
    await tick();
    expect(p.last().update).toEqual({ checkedAt: "2026-11-20T00:00:00Z", error: "build failed" });
  });
});
