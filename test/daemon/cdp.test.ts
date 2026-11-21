import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpConnection, COMMAND_TIMEOUT_MS } from "../../daemon/cdp.ts";

class Socket extends EventTarget {
  static OPEN = 1;
  static latest: Socket;
  readyState = 0;
  sent: Array<{ id: number; method: string; sessionId?: string }> = [];
  constructor(_url: string) { super(); Socket.latest = this; }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  reply(message: object) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(message) })); }
}

async function connect() {
  vi.stubGlobal("WebSocket", Socket);
  const connecting = CdpConnection.connect("ws://localhost/browser");
  const socket = Socket.latest;
  socket.open();
  return { cdp: await connecting, socket };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("CDP command deadlines", () => {
  it("times out an unanswered command, ignores its late reply and permits the release command", async () => {
    vi.useFakeTimers();
    const { cdp, socket } = await connect();
    const preparing = expect(cdp.send("Fetch.enable", {}, "pet")).rejects.toThrow("CDP command timed out after 5000 ms (Fetch.enable)");
    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
    await preparing;
    socket.reply({ id: socket.sent[0]!.id, result: { late: true } });
    const released = cdp.send("Runtime.runIfWaitingForDebugger", {}, "pet");
    expect(socket.sent.at(-1)).toMatchObject({ method: "Runtime.runIfWaitingForDebugger", sessionId: "pet" });
    socket.reply({ id: socket.sent.at(-1)!.id, result: {} });
    await expect(released).resolves.toEqual({});
    expect(vi.getTimerCount()).toBe(0);
    cdp.close();
  });

  it("clears command deadlines on protocol failures and disconnect", async () => {
    vi.useFakeTimers();
    const { cdp, socket } = await connect();
    const failed = expect(cdp.send("Runtime.addBinding")).rejects.toThrow("Runtime.addBinding: rejected");
    socket.reply({ id: socket.sent[0]!.id, error: { message: "rejected" } });
    await failed;
    const disconnected = expect(cdp.send("Page.enable")).rejects.toThrow("CDP connection closed (Page.enable)");
    cdp.close();
    await disconnected;
    await cdp.closed;
    expect(vi.getTimerCount()).toBe(0);
  });
});
