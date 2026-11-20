import { describe, expect, it } from "vitest";
import { type DiscoveryDeps, type Endpoint, debuggingPorts, discoveryLoop, findDesktop } from "../../daemon/desktop.ts";

const PS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=58071",
  "/Applications/Google Chrome.app/Contents/Frameworks/Helper --type=renderer --remote-debugging-port=58071",
  "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=58547",
  "/bin/zsh",
].join("\n");

function deps(ps: string, pages: Record<number, string[]>): DiscoveryDeps {
  return {
    processArgs: async () => ps,
    fetchJson: async (url) => {
      const port = Number(new URL(url).port);
      if (!(port in pages)) throw new Error("ECONNREFUSED");
      if (url.endsWith("/json/list")) return pages[port].map((u) => ({ type: "page", url: u }));
      return { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` };
    },
  };
}

describe("discovery", () => {
  it("parses unique debugging ports", () => {
    expect(debuggingPorts(PS)).toEqual([58071, 58547]);
  });

  it("picks the process with an app://-/index.html page and ignores Chrome", async () => {
    const found = await findDesktop(deps(PS, { 58071: ["https://flow.google.com/"], 58547: ["app://-/index.html"] }));
    expect(found).toEqual({ port: 58547, browserUrl: "ws://127.0.0.1:58547/devtools/browser/x" });
    expect(await findDesktop(deps(PS, { 58071: ["https://flow.google.com/"] }))).toBeNull();
  });

  it("rediscovers on a new port after a disconnect", async () => {
    let ps = PS;
    const pages = { 58547: ["app://-/index.html"], 60001: ["app://-/index.html?initialRoute=%2Favatar-overlay", "app://-/index.html"] };
    const d = deps("", pages);
    d.processArgs = async () => ps;
    const sessions: Endpoint[] = [];
    const controller = new AbortController();
    await discoveryLoop({
      find: () => findDesktop(d),
      log: () => {},
      intervalMs: 5,
      signal: controller.signal,
      session: async (endpoint) => {
        sessions.push(endpoint);
        if (sessions.length === 1) ps = "/bin/zsh"; // Desktop quit: nothing to find for a while
        setTimeout(() => (ps = PS.replace("58547", "60001")), 20); // ...then restarts on another port
        if (sessions.length === 2) controller.abort();
      },
    });
    expect(sessions.map((s) => s.port)).toEqual([58547, 60001]);
  });
});
