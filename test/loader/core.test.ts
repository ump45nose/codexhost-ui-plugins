import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLoader } from "../../loader/core.ts";
import { fakeWindow } from "./fake-window.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(kind: "main" | "pet" = "main") {
  const page = fakeWindow(kind);
  startLoader(page.win, "build-1");
  return page;
}

describe("loader isolation (C1.4)", () => {
  it("fails a throwing plugin and an api.fail plugin, keeps the normal one active", () => {
    const page = setup();
    const syncFailCleanup = vi.fn();
    const laterFailCleanup = vi.fn();
    const okCleanup = vi.fn();
    let laterFail!: (reason: string) => void;
    page.register("thrower", () => {
      throw new Error("boom");
    });
    page.register("sync-fail", (api) => {
      api.fail("no anchor");
      return syncFailCleanup;
    });
    page.register("later-fail", (api) => {
      laterFail = api.fail;
      return laterFailCleanup;
    });
    page.register("ok", () => okCleanup);
    page.push([{ id: "thrower" }, { id: "sync-fail" }, { id: "later-fail" }, { id: "ok" }]);

    expect(page.loader().getState().local["later-fail"]?.status).toBe("active");
    laterFail("element vanished");

    const { local } = page.loader().getState();
    expect(local.thrower).toEqual({ status: "failed", reason: "boom" });
    expect(local["sync-fail"]).toEqual({ status: "failed", reason: "no anchor" });
    expect(local["later-fail"]).toEqual({ status: "failed", reason: "element vanished" });
    expect(local.ok).toEqual({ status: "active", reason: undefined });
    expect(syncFailCleanup).toHaveBeenCalledOnce();
    expect(laterFailCleanup).toHaveBeenCalledOnce();
    expect(okCleanup).not.toHaveBeenCalled();
    expect(page.statuses("thrower")).toEqual(["failed"]);
    expect(page.statuses("ok")).toEqual(["active"]);
    expect(page.doc.getElementById("cxp-failure-notice")?.textContent).toContain("插件「thrower」已停用：boom");

    // A failed plugin stays down on later state pushes until retried.
    page.push([{ id: "thrower" }, { id: "sync-fail" }, { id: "later-fail" }, { id: "ok" }]);
    expect(page.loader().getState().local["later-fail"]?.status).toBe("failed");
  });

  it("retry runs the lifecycle again once the daemon clears the failure", () => {
    const page = setup();
    let broken = true;
    page.register("flaky", () => {
      if (broken) throw new Error("not yet");
    });
    page.push([{ id: "flaky" }]);
    page.push([{ id: "flaky", status: "failed", source: "main", reason: "not yet" }]); // the daemon echoes the failure
    expect(page.loader().getState().local.flaky?.status).toBe("failed");
    broken = false;
    page.loader().retry("flaky");
    expect(page.sent.at(-1)).toEqual({ type: "retry", plugin: "flaky" });
    expect(page.loader().getState().local.flaky?.status).toBe("failed");
    page.push([{ id: "flaky" }]); // the daemon cleared the page failure
    expect(page.loader().getState().local.flaky?.status).toBe("active");
    expect(page.doc.getElementById("cxp-failure-notice")?.textContent ?? "").not.toContain("flaky");
  });

  it("does not show the notice in the pet window", () => {
    const page = setup("pet");
    page.register("thrower", () => {
      throw new Error("boom");
    });
    page.push([{ id: "thrower" }]);
    expect(page.loader().getState().local.thrower?.status).toBe("failed");
    expect(page.doc.getElementById("cxp-failure-notice")).toBeNull();
  });
});

describe("fork guards (C1.5)", () => {
  it("is dormant while a guard is present and activates within 10 s after it goes", () => {
    const page = setup();
    page.win.__forkStash = {};
    const activate = vi.fn();
    page.register("stash", activate, ["__forkStash"]);
    page.push([{ id: "stash" }]);
    expect(page.loader().getState().local.stash?.status).toBe("dormant");
    expect(activate).not.toHaveBeenCalled();

    delete page.win.__forkStash;
    vi.advanceTimersByTime(10_000);
    expect(page.loader().getState().local.stash?.status).toBe("active");
    expect(activate).toHaveBeenCalledOnce();
  });

  it("cleans up and goes dormant within 1 s when a guard appears after activation", () => {
    const page = setup();
    const cleanup = vi.fn();
    page.register("stash", () => cleanup, ["__forkStash"]);
    page.push([{ id: "stash" }]);
    expect(page.loader().getState().local.stash?.status).toBe("active");

    vi.advanceTimersByTime(3_000);
    page.win.__forkStash = {};
    vi.advanceTimersByTime(1_000);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(page.loader().getState().local.stash?.status).toBe("dormant");
    expect(page.statuses("stash")).toEqual(["active", "dormant"]);
  });

  it("keeps checking every 10 s after the first 15 s", () => {
    const page = setup();
    const cleanup = vi.fn();
    page.register("stash", () => cleanup, ["__forkStash"]);
    page.push([{ id: "stash" }]);
    vi.advanceTimersByTime(60_000);
    page.win.__forkStash = {};
    vi.advanceTimersByTime(10_000);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(page.loader().getState().local.stash?.status).toBe("dormant");
  });
});

describe("enable, settings and daemon failures (C1.5b)", () => {
  it("setEnabled off then on restores a plugin without reload", () => {
    const page = setup();
    const cleanup = vi.fn();
    const activate = vi.fn(() => cleanup);
    page.register("stash", activate);
    page.push([{ id: "stash" }]);

    page.loader().setEnabled("stash", false);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(page.loader().getState().local.stash?.status).toBe("off");

    page.loader().setEnabled("stash", true);
    expect(activate).toHaveBeenCalledTimes(2);
    expect(page.loader().getState().local.stash?.status).toBe("active");
    expect(page.sent.filter((m) => m.type === "enable")).toEqual([
      { type: "enable", plugin: "stash", enabled: false },
      { type: "enable", plugin: "stash", enabled: true },
    ]);
    expect(page.statuses("stash")).toEqual(["active", "off", "active"]);
  });

  it("does not start disabled plugins", () => {
    const page = setup();
    const activate = vi.fn();
    page.register("stash", activate);
    page.push([{ id: "stash", enabled: false }]);
    expect(activate).not.toHaveBeenCalled();
    expect(page.statuses("stash")).toEqual(["off"]);
  });

  it("cleans up a plugin the daemon marks failed from the rewriter and does not restart it", () => {
    const page = setup("pet");
    const cleanup = vi.fn();
    const activate = vi.fn(() => cleanup);
    page.register("pet", activate);
    page.push([{ id: "pet" }]);
    expect(activate).toHaveBeenCalledOnce();

    const failed = { id: "pet", status: "failed" as const, source: "rewriter", reason: "chunk not found" };
    page.push([failed]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(page.loader().getState().local.pet).toEqual({ status: "failed", reason: "chunk not found" });

    page.push([failed]);
    vi.advanceTimersByTime(60_000);
    expect(activate).toHaveBeenCalledOnce();
    // The page does not claim the rewriter's failure as its own.
    expect(page.statuses("pet")).toEqual(["active"]);
  });

  it("re-activates with new settings after a settings change", () => {
    const page = setup();
    const cleanup = vi.fn();
    const seen: unknown[] = [];
    page.register("picker", (api) => {
      seen.push(api.settings.dir);
      return cleanup;
    });
    page.push([{ id: "picker", settings: { dir: "/a" } }]);
    page.loader().setSettings("picker", { dir: "/b" });
    expect(page.sent.at(-1)).toEqual({ type: "settings:set", plugin: "picker", values: { dir: "/b" } });
    // The daemon echoes the saved settings; no extra restart.
    page.push([{ id: "picker", settings: { dir: "/b" } }]);
    page.push([{ id: "picker", settings: { dir: "/c" } }]);
    expect(seen).toEqual(["/a", "/b", "/c"]);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});

describe("channel and startup", () => {
  it("says hello and reports focus", () => {
    const page = fakeWindow();
    const listeners: Record<string, () => void> = {};
    page.win.addEventListener = (type: string, fn: () => void) => (listeners[type] = fn);
    startLoader(page.win, "build-1");
    listeners.blur();
    expect(page.sent).toEqual([
      { type: "hello", window: "main", buildId: "build-1", focused: true },
      { type: "focus", focused: false },
    ]);
  });

  it("waits for Host routing up to 30 s, then starts anyway", () => {
    const page = fakeWindow();
    delete page.win.__codexhostHostRoutingV1;
    startLoader(page.win, "build-1");
    const activate = vi.fn();
    page.register("stash", activate);
    page.push([{ id: "stash" }]);
    vi.advanceTimersByTime(29_000);
    expect(activate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(activate).toHaveBeenCalledOnce();
  });

  it("ignores a second evaluation except to say hello and resend statuses", () => {
    const page = setup();
    const activate = vi.fn();
    page.register("stash", activate);
    page.push([{ id: "stash" }]);
    const api = page.loader();
    startLoader(page.win, "build-1");
    page.register("stash", activate);
    expect(page.loader()).toBe(api);
    expect(activate).toHaveBeenCalledOnce();
    expect(page.sent.slice(-2)).toEqual([
      { type: "hello", window: "main", buildId: "build-1", focused: true },
      { type: "status", plugin: "stash", state: "active" },
    ]);
  });

  it("routes api.request through the daemon and settles responses", async () => {
    const page = setup();
    let result!: Promise<unknown>;
    let failing!: Promise<unknown>;
    page.register("picker", (api) => {
      result = api.request("applyDefaultDirectory", { now: true });
      failing = api.request("missing");
    });
    page.push([{ id: "picker" }]);
    const requests = page.sent.filter((m) => m.type === "request");
    expect(requests[0]).toEqual({ type: "request", id: 1, plugin: "picker", method: "applyDefaultDirectory", params: { now: true } });
    page.win.__cxpReceive({ type: "response", id: 1, result: "ok" });
    page.win.__cxpReceive({ type: "response", id: 2, error: "no handler" });
    await expect(result).resolves.toBe("ok");
    await expect(failing).rejects.toThrow("no handler");
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const page = setup();
    const listener = vi.fn();
    const off = page.loader().subscribe(listener);
    page.register("stash", () => {});
    page.push([{ id: "stash" }]);
    expect(listener).toHaveBeenCalled();
    expect(listener.mock.lastCall?.[0].daemon.plugins[0].id).toBe("stash");
    off();
    listener.mockClear();
    page.loader().setEnabled("stash", false);
    expect(listener).not.toHaveBeenCalled();
  });
});
