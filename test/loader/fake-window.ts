// Hand-made page stand-in for loader tests: a window object with just what the loader touches.
import type { DaemonPlugin, DaemonState, LoaderV1, LoaderWindow } from "../../loader/core.ts";

class FakeElement {
  id = "";
  title = "";
  textContent = "";
  style = { cssText: "" };
  isConnected = false;
  private doc: FakeDocument;
  constructor(doc: FakeDocument) {
    this.doc = doc;
  }
  setAttribute(): void {}
  addEventListener(): void {}
  remove(): void {
    this.doc.nodes.delete(this);
    this.isConnected = false;
  }
}

class FakeDocument {
  nodes = new Set<FakeElement>();
  body = { append: (el: FakeElement) => (this.nodes.add(el), (el.isConnected = true)) };
  hasFocus = () => true;
  createElement = () => new FakeElement(this);
  getElementById = (id: string) => [...this.nodes].find((n) => n.id === id) ?? null;
}

export function fakeWindow(kind: "main" | "pet" = "main") {
  const sent: any[] = [];
  const doc = new FakeDocument();
  const win: LoaderWindow = {
    __cxpWindow: kind,
    document: doc as unknown as Document,
    addEventListener() {},
    __cxpDaemon: (json: string) => sent.push(JSON.parse(json)),
    __codexhostHostRoutingV1: {},
  };
  return {
    win,
    doc,
    sent,
    loader: () => win.__cxpLoaderV1 as LoaderV1,
    register: (id: string, activate: (api: any) => any, forkGuards: string[] = []) =>
      win.__cxpLoaderRegister(id, activate, { forkGuards }),
    push: (plugins: Array<Partial<DaemonPlugin> & { id: string }>) => {
      const state: DaemonState = {
        buildId: "test",
        plugins: plugins.map((p) => ({
          name: p.id,
          enabled: true,
          settings: {},
          settingFields: [],
          status: "active",
          ...p,
        })),
        update: { checkedAt: null },
      };
      win.__cxpReceive({ type: "state", ...state });
    },
    statuses: (plugin: string) => sent.filter((m) => m.type === "status" && m.plugin === plugin).map((m) => m.state),
  };
}
