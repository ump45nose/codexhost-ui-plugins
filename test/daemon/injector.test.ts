import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyUrl, Injector } from "../../daemon/injector.ts";
import { FakeCdp, plugin, rule, setup, tick } from "./helpers.ts";

const MAIN = "app://-/index.html";
const PET = "app://-/index.html?initialRoute=%2Favatar-overlay";
const flush = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

async function start(plugins = [plugin("a")], buildId = "build-1") {
  const { channel, registry } = setup(plugins, buildId);
  const cdp = new FakeCdp();
  const injector = new Injector(cdp, channel, () => {});
  await injector.start();
  const attach = async (sid: string, url: string, waiting = false, type = "page") => {
    cdp.emit("Target.attachedToTarget", { sessionId: sid, targetInfo: { type, url, targetId: `t-${sid}` }, waitingForDebugger: waiting });
    await flush();
  };
  const hello = (sid: string, window: string, focused: boolean, build = buildId) =>
    cdp.emit("Runtime.bindingCalled", { name: "__cxpDaemon", payload: JSON.stringify({ type: "hello", window, buildId: build, focused }) }, sid);
  return { cdp, channel, registry, injector, attach, hello };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("classifyUrl", () => {
  it("recognises main and Pet, ignores the rest", () => {
    expect(classifyUrl(MAIN)).toBe("main");
    expect(classifyUrl(`${MAIN}#/thread/1`)).toBe("main");
    expect(classifyUrl(PET)).toBe("pet");
    expect(classifyUrl(`${MAIN}?initialRoute=%2Fsettings`)).toBeNull();
    expect(classifyUrl("https://chatgpt.com/")).toBeNull();
  });
});

describe("injector", () => {
  it("sets up a new Pet page in order, before letting it run", async () => {
    const t = await start([plugin("pet", { windows: ["pet"], rewrites: [rule("r", () => false, () => null)] })]);
    await t.attach("s1", PET, true);
    expect(t.cdp.methods("s1")).toEqual([
      "Runtime.enable",
      "Runtime.addBinding",
      "Page.enable",
      "Network.setCacheDisabled",
      "Fetch.enable",
      "Page.addScriptToEvaluateOnNewDocument",
      "Runtime.runIfWaitingForDebugger",
    ]);
    expect(t.cdp.calls.find((c) => c.method === "Fetch.enable")?.params.patterns).toEqual([
      { urlPattern: "*", resourceType: "Script", requestStage: "Response" },
    ]);
  });

  it("evaluates the script in an already-loaded page and reloads a loaded Pet once", async () => {
    const t = await start([plugin("pet", { windows: ["pet"], rewrites: [rule("r", () => false, () => null)] })]);
    await t.attach("m", MAIN);
    await t.attach("p", PET);
    expect(t.cdp.methods("m")).toEqual(["Runtime.enable", "Runtime.addBinding", "Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate"]);
    expect(t.cdp.methods("p").filter((m) => m === "Page.reload")).toHaveLength(1);
    // Re-attaching the same target (e.g. a new session) does not reload it again.
    t.cdp.emit("Target.attachedToTarget", { sessionId: "p2", targetInfo: { type: "page", url: PET, targetId: "t-p" }, waitingForDebugger: false });
    await flush();
    expect(t.cdp.methods("p2")).not.toContain("Page.reload");
  });

  it("does not reload a loaded Pet when no rewrite rules are enabled; ignores other targets", async () => {
    const t = await start([plugin("pet", { windows: ["pet"], enabled: false, rewrites: [rule("r", () => false, () => null)] })]);
    await t.attach("p", PET);
    expect(t.cdp.methods("p")).not.toContain("Page.reload");
    expect(t.cdp.methods("p")).not.toContain("Fetch.enable");
    await t.attach("w", "https://chatgpt.com/api/auth/session", true, "webview");
    expect(t.cdp.methods("w")).toEqual(["Runtime.runIfWaitingForDebugger"]);
  });

  it("composes the script per window: marker, loader, that window's plugins in manifest order", async () => {
    const t = await start([
      plugin("one", { windows: ["main"], file: "one.js" }),
      plugin("two", { windows: ["pet", "main"], file: "two.js" }),
      plugin("three", { windows: ["pet"], file: "three.js" }),
    ]);
    expect(t.registry.script("main").split("\n")).toEqual([
      'globalThis.__cxpWindow = "main";',
      "globalThis.__cxpLoaderV1 = {};",
      "/* one */",
      "/* two */",
    ]);
    await t.attach("m", MAIN, true);
    const script = t.cdp.calls.find((c) => c.method === "Page.addScriptToEvaluateOnNewDocument")!.params.source;
    for (const [href, expected] of [[MAIN, "main"], [PET, "pet"], ["about:blank", undefined]] as const) {
      const ctx: Record<string, unknown> = { location: { href }, URL };
      runInNewContext(script, ctx);
      expect(ctx.__cxpWindow).toBe(expected);
      expect(ctx.__cxpLoaderV1 !== undefined).toBe(expected !== undefined);
    }
  });

  it("a page attached at about:blank is classified when it navigates", async () => {
    const t = await start([plugin("pet", { windows: ["pet"], rewrites: [rule("r", () => false, () => null)] })]);
    await t.attach("n", "about:blank", true);
    expect(t.cdp.methods("n")).toContain("Fetch.enable");
    t.cdp.emit("Page.frameNavigated", { frame: { id: "f", url: MAIN } }, "n");
    await flush();
    expect(t.cdp.methods("n")).toContain("Fetch.disable");
    t.hello("n", "main", false);
    await flush();
    const pushes = t.cdp.calls.filter((c) => c.sessionId === "n" && String(c.params.expression).startsWith("window.__cxpReceive"));
    expect(pushes.length).toBeGreaterThan(0);
  });

  it("reloads all pages for a stale build only once the main window is unfocused", async () => {
    const t = await start([plugin("a")], "build-2");
    await t.attach("m", MAIN);
    await t.attach("p", PET);
    t.hello("m", "main", true, "build-1");
    t.hello("p", "pet", false, "build-1");
    await flush();
    expect(t.cdp.calls.filter((c) => c.method === "Page.reload")).toHaveLength(0);
    t.cdp.emit("Runtime.bindingCalled", { name: "__cxpDaemon", payload: JSON.stringify({ type: "focus", focused: false }) }, "m");
    await flush();
    expect(t.cdp.calls.filter((c) => c.method === "Page.reload").map((c) => c.sessionId).sort()).toEqual(["m", "p"]);
    // The reloaded pages still report the old build (a broken build): no reload loop.
    t.hello("m", "main", false, "build-1");
    await flush();
    expect(t.cdp.calls.filter((c) => c.method === "Page.reload")).toHaveLength(2);
  });
});

describe("rewriter", () => {
  const body = (s: string) => ({ body: Buffer.from(s).toString("base64"), base64Encoded: true });
  const decoded = (c: { params: { body: string } }) => Buffer.from(c.params.body, "base64").toString();

  async function petWith(plugins: ReturnType<typeof plugin>[]) {
    const t = await start(plugins);
    await t.attach("p", PET, true);
    await t.attach("m", MAIN, true);
    return t;
  }
  const pause = async (t: Awaited<ReturnType<typeof start>>, sid: string, source: string, status = 200) => {
    t.cdp.responders["Fetch.getResponseBody"] = () => body(source);
    t.cdp.emit("Fetch.requestPaused", { requestId: `r${t.cdp.calls.length}`, request: { url: "app://-/assets/a.js" }, responseStatusCode: status, responseHeaders: [{ name: "Content-Length", value: "3" }, { name: "Content-Type", value: "text/javascript" }] }, sid);
    await flush();
    return t.cdp.calls.filter((c) => c.method === "Fetch.fulfillRequest" || c.method === "Fetch.continueRequest").at(-1)!;
  };

  it("rewrites a Pet chunk; a rule that recognises but cannot apply fails only its plugin", async () => {
    const t = await petWith([
      plugin("bad", { windows: ["pet"], rewrites: [rule("mark", (s) => s.includes("PET"), (s) => `/*bad*/${s}`), rule("broken", (s) => s.includes("PET"), () => null)] }),
      plugin("good", { windows: ["pet"], rewrites: [rule("swap", (s) => s.includes("PET"), (s) => s.replace("PET", "PATCHED"))] }),
      plugin("main-only"),
    ]);
    const done = await pause(t, "p", "let x = 'PET';");
    expect(done.method).toBe("Fetch.fulfillRequest");
    expect(decoded(done as never)).toBe("let x = 'PATCHED';"); // bad's first edit was dropped too
    expect(done.params.responseHeaders).toEqual([{ name: "Content-Type", value: "text/javascript" }]);
    expect(t.channel.aggregate("bad")).toEqual({ status: "failed", source: "rewriter", reason: "rewrite rule broken recognised a Pet chunk but could not apply" });
    expect(t.channel.aggregate("good").status).toBe("active");
    expect(t.channel.aggregate("main-only").status).toBe("active");
  });

  it("continues unmatched, non-2xx, main-window and throwing-rule requests", async () => {
    const t = await petWith([plugin("x", { windows: ["pet"], rewrites: [rule("boom", (s) => s.includes("BOOM"), () => { throw new Error("bad regex"); })] })]);
    expect((await pause(t, "p", "nothing here")).method).toBe("Fetch.continueRequest");
    expect((await pause(t, "p", "PET", 304)).method).toBe("Fetch.continueRequest");
    expect((await pause(t, "m", "BOOM")).method).toBe("Fetch.continueRequest");
    expect(t.channel.aggregate("x").status).toBe("active");
    expect((await pause(t, "p", "BOOM")).method).toBe("Fetch.continueRequest");
    expect(t.channel.aggregate("x")).toMatchObject({ status: "failed", source: "rewriter", reason: "rewrite rule boom threw: bad regex" });
    t.cdp.responders["Fetch.getResponseBody"] = () => {
      throw new Error("No resource with given identifier");
    };
    t.cdp.emit("Fetch.requestPaused", { requestId: "gone", request: { url: "u" }, responseStatusCode: 200 }, "p");
    await flush();
    expect(t.cdp.calls.at(-1)).toMatchObject({ method: "Fetch.continueRequest", params: { requestId: "gone" } });
  });

  it("fails a plugin whose rules recognised nothing within 10 s of Pet load; a new load clears it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = await petWith([
      plugin("found", { windows: ["pet"], rewrites: [rule("f", (s) => s.includes("PET"), (s) => s)] }),
      plugin("lost", { windows: ["pet"], rewrites: [rule("l1", () => false, () => null), rule("l2", () => false, () => null)] }),
      plugin("off", { windows: ["pet"], enabled: false, rewrites: [rule("o", () => false, () => null)] }),
    ]);
    await pause(t, "p", "PET");
    t.cdp.emit("Page.loadEventFired", {}, "p");
    vi.advanceTimersByTime(9_999);
    expect(t.channel.aggregate("lost").status).toBe("active");
    vi.advanceTimersByTime(1);
    expect(t.channel.aggregate("lost")).toEqual({ status: "failed", source: "rewriter", reason: "no Pet chunk matched rewrite rule(s) l1, l2 within 10 s of load" });
    expect(t.channel.aggregate("found").status).toBe("active");
    expect(t.channel.aggregate("off").status).toBe("off");
    t.cdp.emit("Page.frameNavigated", { frame: { id: "f", url: PET } }, "p");
    await flush();
    expect(t.channel.aggregate("lost").status).toBe("active");
  });

  it("reloads Pet when a plugin with rewrites is switched, or retried after a rewriter failure", async () => {
    const t = await petWith([plugin("pet", { windows: ["pet"], rewrites: [rule("r", () => true, () => null)] }), plugin("plain")]);
    const reloads = () => t.cdp.calls.filter((c) => c.method === "Page.reload" && c.sessionId === "p").length;
    const send = (msg: object) => t.cdp.emit("Runtime.bindingCalled", { name: "__cxpDaemon", payload: JSON.stringify(msg) }, "m");
    send({ type: "enable", plugin: "plain", enabled: false });
    await flush();
    expect(reloads()).toBe(0);
    send({ type: "enable", plugin: "pet", enabled: false });
    await flush();
    expect(reloads()).toBe(1);
    expect(t.cdp.methods("p")).toContain("Fetch.disable");
    send({ type: "enable", plugin: "pet", enabled: true });
    await flush();
    expect(reloads()).toBe(2);
    await pause(t, "p", "x");
    expect(t.channel.aggregate("pet").status).toBe("failed");
    send({ type: "retry", plugin: "pet" });
    await flush();
    expect(reloads()).toBe(3);
  });
});
