// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket, using flatten sessions
// (child sessions share the browser socket and are addressed by `sessionId`).

export type CdpResult = any;
export type CdpHandler = (params: CdpResult, sessionId?: string) => void;

/** What the injector and rewriter need from a CDP connection; tests supply a fake. */
export interface Cdp {
  send(method: string, params?: object, sessionId?: string): Promise<CdpResult>;
  on(event: string, handler: CdpHandler): void;
}

export class CdpConnection implements Cdp {
  readonly closed: Promise<void>;
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve(v: CdpResult): void; reject(e: Error): void; method: string }>();
  #handlers = new Map<string, CdpHandler[]>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", () => {
        for (const p of this.#pending.values()) p.reject(new Error(`CDP connection closed (${p.method})`));
        this.#pending.clear();
        resolve();
      });
    });
    ws.addEventListener("message", (event) => this.#onMessage(String(event.data)));
  }

  static connect(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const conn = new CdpConnection(ws);
      ws.addEventListener("open", () => resolve(conn), { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<CdpResult> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      if (this.#ws.readyState !== WebSocket.OPEN) return reject(new Error(`CDP connection closed (${method})`));
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  on(event: string, handler: CdpHandler): void {
    const list = this.#handlers.get(event) ?? [];
    list.push(handler);
    this.#handlers.set(event, list);
  }

  close(): void {
    this.#ws.close();
  }

  #onMessage(data: string): void {
    const msg = JSON.parse(data) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: unknown;
      sessionId?: string;
    };
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    for (const handler of this.#handlers.get(msg.method) ?? []) {
      try {
        handler(msg.params, msg.sessionId);
      } catch (error) {
        console.error(new Date().toISOString(), `CDP handler for ${msg.method} threw`, error);
      }
    }
  }
}
