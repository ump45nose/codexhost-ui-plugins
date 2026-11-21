import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_TIMEOUT_MS } from "../../daemon/cdp.ts";
import { classifyUrl, Injector } from "../../daemon/injector.ts";
import { petRewrites } from "../../plugins/pet/rewrites.ts";
import { FakeCdp, plugin, rule, setup, tick } from "./helpers.ts";

const MAIN = "app://-/index.html";
const PET = "app://-/index.html?initialRoute=%2Favatar-overlay";
const flush = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

async function start(plugins = [plugin("a")], buildId = "build-1") {
  const { channel, registry, logs } = setup(plugins, buildId);
  const cdp = new FakeCdp();
  const injector = new Injector(channel, (...args) => logs.push(args));
  await injector.start(cdp);
  const attach = async (sid: string, url: string, waiting = false, type = "page") => {
    cdp.emit("Target.attachedToTarget", { sessionId: sid, targetInfo: { type, url, targetId: `t-${sid}` }, waitingForDebugger: waiting });
    await flush();
  };
  const hello = (sid: string, window: string, focused: boolean, build = buildId) =>
    cdp.emit("Runtime.bindingCalled", { name: "__cxpDaemon", payload: JSON.stringify({ type: "hello", window, buildId: build, focused }) }, sid);
  return { cdp, channel, registry, injector, attach, hello, logs };
}

/** A complete document can precede Page.enable, so no frameNavigated event is replayed. */
function documentAt(t: Awaited<ReturnType<typeof start>>, href: string) {
  const location = { href };
  const context: Record<string, unknown> = { location, URL };
  let newDocumentScript = "";
  t.cdp.responders["Page.getFrameTree"] = () => ({ frameTree: { frame: { id: "root", url: location.href } } });
  t.cdp.responders["Page.addScriptToEvaluateOnNewDocument"] = (params) => {
    newDocumentScript = params.source;
    return { identifier: "loader" };
  };
  t.cdp.responders["Runtime.evaluate"] = (params) => {
    if (params.expression.startsWith("switch (")) runInNewContext(params.expression, context);
    return { result: { value: false } };
  };
  return { context, navigate(url: string) { location.href = url; runInNewContext(newDocumentScript, context); } };
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
    expect(t.cdp.methods("m")).toEqual(["Runtime.enable", "Runtime.addBinding", "Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate", "Runtime.runIfWaitingForDebugger"]);
    expect(t.cdp.methods("p").filter((m) => m === "Page.reload")).toHaveLength(1);
  });

  it("does not reload a loaded Pet when no rewrite rules are enabled; ignores other targets", async () => {
    const t = await start([plugin("pet", { windows: ["pet"], enabled: false, rewrites: [rule("r", () => false, () => null)] })]);
    await t.attach("p", PET);
    expect(t.cdp.methods("p")).not.toContain("Page.reload");
    expect(t.cdp.methods("p")).not.toContain("Fetch.enable");
    await t.attach("w", "https://chatgpt.com/api/auth/session", true, "webview");
    expect(t.cdp.methods("w")).toEqual(["Runtime.runIfWaitingForDebugger"]);
  });

  const preparationCommands = [
    "Runtime.enable", "Runtime.addBinding", "Page.enable", "Network.setCacheDisabled",
    "Fetch.enable", "Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate",
  ];

  it.each(preparationCommands)("releases the target when %s never replies", async (method) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const evaluating = method === "Runtime.evaluate";
    const t = await start([plugin("pet", { windows: ["pet"], rewrites: [rule("r", () => false, () => null)] })]);
    t.cdp.responders[method] = () => new Promise(() => {});
    await t.attach("p", evaluating ? MAIN : PET, !evaluating);
    expect(t.cdp.methods("p")).not.toContain("Runtime.runIfWaitingForDebugger");
    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
    await flush();
    expect(t.cdp.methods("p").filter((m) => m === "Runtime.runIfWaitingForDebugger")).toHaveLength(1);
    expect(t.logs.map((args) => String(args[0])).filter((line) => /target (attached|prepared|released)/.test(line))).toEqual([
      expect.stringContaining("target attached t-p session=p at="),
      expect.stringContaining("target prepared t-p session=p at="),
      expect.stringContaining("target released t-p session=p at="),
    ]);
    t.injector.dispose();
  });

  it.each(preparationCommands)("releases the target when %s fails", async (method) => {
    const evaluating = method === "Runtime.evaluate";
    const t = await start([plugin("pet", { windows: ["pet"], rewrites: [rule("r", () => false, () => null)] })]);
    t.cdp.responders[method] = () => { throw new Error("preparation failed"); };
    await t.attach("p", evaluating ? MAIN : PET, !evaluating);
    expect(t.cdp.methods("p").filter((m) => m === "Runtime.runIfWaitingForDebugger")).toHaveLength(1);
    t.injector.dispose();
  });

  it.each(["", "about:blank"])("releases a paused blank target (%s) before Runtime.enable and injects its already complete Pet", async (url) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const t = await start([plugin("pet", { windows: ["pet"] })]);
    const doc = documentAt(t, PET);
    let released = false;
    t.cdp.responders["Runtime.enable"] = () => released ? {} : new Promise(() => {});
    t.cdp.responders["Runtime.runIfWaitingForDebugger"] = () => { released = true; return {}; };
    const started = Date.now();
    await t.attach("cold", url, true);
    expect(released).toBe(true);
    expect(t.cdp.methods("cold")[0]).toBe("Runtime.runIfWaitingForDebugger");
    expect(doc.context.__cxpWindow).toBe("pet");
    expect(doc.context.__cxpLoaderV1).toEqual({});
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(t.logs.some((args) => String(args[0]).includes("after-release"))).toBe(true);
    t.hello("cold", "pet", false);
    await flush();
    expect(t.cdp.calls.some((call) => call.sessionId === "cold" && String(call.params.expression).startsWith("window.__cxpReceive"))).toBe(true);
    t.injector.dispose();
  });

  it.each(["failure", "timeout"])("retries preparation after releasing a target when Runtime.enable has a %s, including a missed Pet navigation", async (outcome) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const t = await start([plugin("pet", { windows: ["pet"], rewrites: [rule("r", () => false, () => null)] })]);
    const doc = documentAt(t, PET);
    let released = false;
    t.cdp.responders["Runtime.enable"] = () => {
      if (released) return {};
      if (outcome === "timeout") return new Promise(() => {});
      throw new Error("renderer not ready");
    };
    t.cdp.responders["Runtime.runIfWaitingForDebugger"] = () => { released = true; return {}; };
    const started = Date.now();
    await t.attach("recover", PET, true);
    if (outcome === "timeout") {
      expect(doc.context.__cxpLoaderV1).toBeUndefined();
      expect(released).toBe(false);
      await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
      await flush();
    }
    expect(released).toBe(true);
    expect(doc.context.__cxpWindow).toBe("pet");
    expect(doc.context.__cxpLoaderV1).toEqual({});
    const methods = t.cdp.methods("recover");
    expect(methods.indexOf("Runtime.runIfWaitingForDebugger")).toBeLessThan(methods.lastIndexOf("Runtime.enable"));
    expect(methods.filter((method) => method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(1);
    expect(methods.filter((method) => method === "Page.reload")).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(10_000);
    t.injector.dispose();
  });

  it("keeps the loader registered when a released blank page navigates to Pet later", async () => {
    const t = await start([plugin("pet", { windows: ["pet"] })]);
    const doc = documentAt(t, "about:blank");
    await t.attach("later", "about:blank", true);
    expect(doc.context.__cxpLoaderV1).toBeUndefined();
    t.cdp.emit("Page.frameNavigated", { frame: { id: "root", url: PET } }, "later");
    doc.navigate(PET);
    t.hello("later", "pet", false);
    await flush();
    expect(doc.context.__cxpWindow).toBe("pet");
    expect(doc.context.__cxpLoaderV1).toEqual({});
    expect(t.cdp.calls.some((call) => call.sessionId === "later" && String(call.params.expression).startsWith("window.__cxpReceive"))).toBe(true);
    t.injector.dispose();
  });

  it("releases existing targets during initial auto-attach and a new connection without relying on the waiting flag", async () => {
    const { channel } = setup([plugin("a")]);
    const injector = new Injector(channel, () => {});
    for (let connection = 0; connection < 2; connection++) {
      const cdp = new FakeCdp();
      cdp.responders["Target.setAutoAttach"] = () => {
        cdp.emit("Target.attachedToTarget", { sessionId: "existing", targetInfo: { type: "page", url: MAIN } });
        cdp.emit("Target.attachedToTarget", { sessionId: "worker", targetInfo: { type: "worker", url: "" }, waitingForDebugger: false });
        return {};
      };
      await injector.start(cdp);
      await flush();
      expect(cdp.methods("existing")).toContain("Runtime.runIfWaitingForDebugger");
      expect(cdp.methods("worker")).toEqual(["Runtime.runIfWaitingForDebugger"]);
      injector.dispose();
    }
  });

  it.each(["failure", "timeout"])("detaches a waiting target after a release %s and continues handling other targets", async (outcome) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = await start();
    let waiting = true;
    t.cdp.responders["Runtime.runIfWaitingForDebugger"] = (_params, sid) => {
      if (sid !== "stuck") return {};
      if (outcome === "timeout") return new Promise(() => {});
      throw new Error("cannot release target");
    };
    t.cdp.responders["Target.detachFromTarget"] = (params, sid) => {
      expect(params.sessionId).toBe("stuck");
      expect(sid).toBeUndefined(); // browser command, independent of the blocked target session
      waiting = false;
      return {};
    };
    await t.attach("stuck", MAIN, true);
    if (outcome === "timeout") {
      expect(waiting).toBe(true);
      await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
    }
    await flush();
    expect(waiting).toBe(false);
    expect(t.cdp.closed).toBe(false);
    expect(t.logs.some((args) => String(args[0]).includes("target release failed t-stuck session=stuck at="))).toBe(true);
    expect(t.logs.some((args) => String(args[0]).includes("recovery=detach"))).toBe(true);
    await t.attach("next", MAIN, true);
    expect(t.cdp.methods("next")).toContain("Runtime.runIfWaitingForDebugger");
  });

  it.each(["failure", "timeout"])("closes the debugger connection when fallback detach has a %s, then permits reconnection", async (outcome) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = await start([plugin("pet", { windows: ["pet"], rewrites: [rule("r", () => false, () => null)] })]);
    let waiting = true;
    const close = t.cdp.close.bind(t.cdp);
    const closed = vi.spyOn(t.cdp, "close").mockImplementation(() => { waiting = false; close(); });
    t.cdp.responders["Runtime.runIfWaitingForDebugger"] = () => { throw new Error("cannot release target"); };
    t.cdp.responders["Target.detachFromTarget"] = () => {
      if (outcome === "timeout") return new Promise(() => {});
      throw new Error("cannot detach target");
    };
    await t.attach("stuck", PET, true);
    if (outcome === "timeout") {
      expect(waiting).toBe(true);
      await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
    }
    await flush();
    expect(waiting).toBe(false);
    expect(closed).toHaveBeenCalledOnce();
    expect(t.cdp.closed).toBe(true);
    expect(t.logs.some((args) => String(args[0]).includes("closing debugger connection"))).toBe(true);
    // The failed connection must no longer leave pages registered for reloads.
    const beforeReload = t.cdp.calls.length;
    await t.injector.reloadPets();
    expect(t.cdp.calls).toHaveLength(beforeReload);
    const reconnected = new FakeCdp();
    await t.injector.start(reconnected);
    reconnected.emit("Target.attachedToTarget", { sessionId: "reconnected", targetInfo: { type: "page", url: MAIN }, waitingForDebugger: true });
    await flush();
    expect(reconnected.methods("reconnected")).toContain("Runtime.runIfWaitingForDebugger");
    t.injector.dispose();
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

  it("reloads all pages for a stale build only once the main window is known to be unfocused", async () => {
    const t = await start([plugin("a")], "build-2");
    const reloads = () => t.cdp.calls.filter((c) => c.method === "Page.reload").map((c) => c.sessionId).sort();
    await t.attach("m", MAIN);
    await t.attach("p", PET);
    t.hello("p", "pet", false, "build-1"); // main's focus is still unknown
    await flush();
    t.hello("m", "main", true, "build-1");
    await flush();
    expect(reloads()).toEqual([]);
    t.cdp.emit("Runtime.bindingCalled", { name: "__cxpDaemon", payload: JSON.stringify({ type: "focus", focused: false }) }, "m");
    await flush();
    expect(reloads()).toEqual(["m", "p"]);
    // The reloaded pages report the disk build: no further reload.
    t.hello("p", "pet", false, "build-2");
    t.hello("m", "main", false, "build-2");
    await flush();
    expect(reloads()).toEqual(["m", "p"]);
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

  it("fails a plugin if any rule is not identified within 10 s of Pet load; a new load clears it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = await petWith([
      plugin("found", { windows: ["pet"], rewrites: [rule("f", (s) => s.includes("PET"), (s) => s)] }),
      plugin("lost", { windows: ["pet"], rewrites: [rule("l1", (s) => s.includes("PET"), (s) => s), rule("l2", () => false, () => null)] }),
      plugin("off", { windows: ["pet"], enabled: false, rewrites: [rule("o", () => false, () => null)] }),
    ]);
    await pause(t, "p", "PET");
    t.cdp.emit("Page.loadEventFired", {}, "p");
    vi.advanceTimersByTime(9_999);
    expect(t.channel.aggregate("lost").status).toBe("active");
    vi.advanceTimersByTime(1);
    expect(t.channel.aggregate("lost")).toEqual({ status: "failed", source: "rewriter", reason: "no Pet chunk matched rewrite rule(s) l2 within 10 s of load" });
    expect(t.channel.aggregate("found").status).toBe("active");
    expect(t.channel.aggregate("off").status).toBe("off");
    t.cdp.emit("Page.frameNavigated", { frame: { id: "f", url: PET } }, "p");
    await flush();
    expect(t.channel.aggregate("lost").status).toBe("active");
  });

  it("suspends Pet rewriting when a fork marker is present and signals the page loader", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = await petWith([
      plugin("pet", { windows: ["pet"], rewrites: [rule("r", (s) => s.includes("PET"), () => null)] }),
    ]);
    const done = await pause(t, "p", 'globalThis.__codexhostPetsStackPatched=true; "PET"');
    expect(done.method).toBe("Fetch.fulfillRequest");
    expect(decoded(done as never)).toBe('globalThis.__codexhostPetsStackPatched=true; "PET"\n;globalThis.__cxpPetForkRewriteDetected=true;');
    expect((await pause(t, "p", '"PET"')).method).toBe("Fetch.continueRequest");
    t.cdp.emit("Page.loadEventFired", {}, "p");
    vi.advanceTimersByTime(10_000);
    expect(t.channel.aggregate("pet").status).not.toBe("failed");
  });

  it("suspends on the real fork thread-link chunk before the separate Pet marker chunk arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = await petWith([plugin("pet", { windows: ["pet"], rewrites: petRewrites })]);
    const source = 'assertRequestCurrent:n,clientThreadId:o,onSettled:a});' +
      'assertRequestCurrent:s,clientThreadId:"projectless"===F.type||"remoteProject"===F.type?F.clientThreadId:void 0,onSettled:async e=>{}';
    const done = await pause(t, "p", source);
    expect(done.method).toBe("Fetch.fulfillRequest");
    expect(decoded(done as never)).toBe(`${source}\n;globalThis.__cxpPetForkRewriteDetected=true;`);
    t.cdp.emit("Page.loadEventFired", {}, "p");
    vi.advanceTimersByTime(10_000);
    expect(t.channel.aggregate("pet").status).not.toBe("failed");
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
