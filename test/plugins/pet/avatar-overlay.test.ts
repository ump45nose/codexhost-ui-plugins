import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AVATAR_OVERLAY_AGENT_MENU_ATTR,
  AVATAR_OVERLAY_AGENT_PILL_ATTR,
  AVATAR_OVERLAY_CARD_AGENT_ATTR,
  AVATAR_OVERLAY_ICON_STYLE_ID,
  AVATAR_OVERLAY_ROOT_ATTR,
  AVATAR_OVERLAY_STYLE_ID,
  PETS_HARNESS_CATALOG_STORAGE_KEY,
  PETS_QUICK_CHAT_AGENT_STORAGE_KEY,
  PETS_STACK_MAX_HEIGHT_STORAGE_KEY,
  PETS_THREAD_AGENTS_STORAGE_KEY,
  installPetsStackHeightHook,
  installRendererAvatarOverlay,
  isAvatarOverlayLocation,
  isAvatarOverlayRendererUrl,
  parseNativeActivityId,
  readPetsThreadAgents,
  resolvePetsStackMaxHeight,
  writePetsHarnessCatalog,
  writePetsThreadAgents,
  type RendererAvatarOverlayHandle,
} from "../../../plugins/pet/avatar-overlay/index.ts";
import { writePetsRemoteProjects } from "../../../plugins/pet/quick-chat-target/index.ts";
import {
  CXP_PETS_STACK_MAX_HEIGHT_HOOK,
  CXP_QUICK_CHAT_TARGET_HOOK,
} from "../../../plugins/pet/rewrites.ts";
import { encodeHarnessPluginRoute } from "../../../plugins/pet/vendor/harness-route.ts";
import { FakeDocument, FakeElement, FakeWindow, installFakeMutationObserver } from "./fake-dom.ts";

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

const CLAUDE = {
  id: "claude-code",
  name: "Claude Code",
  iconStyle: {
    vector: { viewBox: "0 0 16 16", color: "#d97757", paths: [{ d: "M2 2h12v12H2z" }] },
  },
};

function setup(presentation = "minimized") {
  const restoreMo = installFakeMutationObserver();
  disposers.push(restoreMo);
  const doc = new FakeDocument();
  const win = new FakeWindow(doc);

  const tray = doc.createElement("div");
  tray.setAttribute("data-avatar-overlay-size", "notification-tray");
  for (const [id, title] of [
    ["local:local:ext-1", "Local Claude"],
    ["remote-host:remote-ssh-discovered:mac-work:r-1", "Remote"],
    ["local:local:codex-1", "Codex"],
  ] as const) {
    const card = doc.createElement("div");
    card.setAttribute("data-avatar-overlay-activity-stack-item", id);
    const titleEl = doc.createElement("div");
    titleEl.setAttribute("data-avatar-overlay-activity-text", "title");
    titleEl.textContent = title;
    card.appendChild(titleEl);
    tray.appendChild(card);
  }
  doc.body.appendChild(tray);

  const quickChat = doc.createElement("div");
  quickChat.setAttribute("data-quick-chat-presentation", presentation);
  const contents = doc.createElement("div");
  contents.className = "contents no-drag";
  const portal = doc.createElement("div");
  portal.setAttribute("data-above-composer-portal", "true");
  contents.appendChild(portal);
  quickChat.appendChild(contents);
  doc.body.appendChild(quickChat);

  const posted: unknown[] = [];
  class FakeMessagePort {
    postMessage(message: unknown) {
      posted.push(message);
    }
  }
  win.MessagePort = FakeMessagePort;

  const find = (selector: string): FakeElement => {
    const el = doc.querySelector(selector);
    if (!el) throw new Error(`missing ${selector}`);
    return el;
  };

  const install = (): RendererAvatarOverlayHandle => {
    const handle = installRendererAvatarOverlay({
      document: doc as unknown as Document,
      window: win as unknown as Window,
      enableRemoteSessions: false,
    });
    disposers.push(handle.dispose);
    return handle;
  };

  const seedCatalog = () => {
    writePetsHarnessCatalog(
      { enabledAgents: ["codex", "claude-code"], plugins: [CLAUDE] },
      win.localStorage as unknown as Storage,
    );
    writePetsThreadAgents(
      { "local:ext-1": "claude-code", "remote-ssh-discovered:mac-work:r-1": "claude-code" },
      win.localStorage as unknown as Storage,
    );
  };

  return { doc, win, find, install, seedCatalog, posted, FakeMessagePort };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("Pet avatar-overlay storage & helpers", () => {
  it("recognizes the Pet window URL forms", () => {
    expect(isAvatarOverlayRendererUrl("app://-/index.html?initialRoute=%2Favatar-overlay")).toBe(
      true,
    );
    expect(isAvatarOverlayRendererUrl("app://-/index.html?desktopSurface=avatarOverlay")).toBe(
      true,
    );
    expect(isAvatarOverlayRendererUrl("app://-/index.html?initialRoute=%2F")).toBe(false);
    expect(
      isAvatarOverlayLocation({ href: "app://-/index.html", pathname: "/index.html", search: "" }),
    ).toBe(false);
  });

  it("parses native activity ids for local and remote hosts", () => {
    expect(parseNativeActivityId("local:local:t-1")).toEqual({ hostId: "local", threadId: "t-1" });
    expect(parseNativeActivityId("remote-host:remote-ssh-discovered:nas:t-2")).toEqual({
      hostId: "remote-ssh-discovered:nas",
      threadId: "t-2",
    });
    expect(parseNativeActivityId("client-new-thread:abc")).toBeNull();
  });

  it("publishes external thread Agents without rewriting unchanged maps", () => {
    const { win } = setup();
    const storage = win.localStorage as unknown as Storage;
    writePetsThreadAgents({ "local:a": "claude-code", "local:b": "codex" }, storage);
    expect([...readPetsThreadAgents(storage)]).toEqual([["local:a", "claude-code"]]);
    const setItem = vi.spyOn(win.localStorage, "setItem");
    writePetsThreadAgents({ "local:a": "claude-code", "local:b": "codex" }, storage);
    expect(setItem).not.toHaveBeenCalledWith(PETS_THREAD_AGENTS_STORAGE_KEY, expect.anything());
    const catalog = { enabledAgents: ["codex", "claude-code"], plugins: [CLAUDE] };
    writePetsHarnessCatalog(catalog, storage);
    setItem.mockClear();
    writePetsHarnessCatalog(catalog, storage);
    expect(setItem).not.toHaveBeenCalledWith(PETS_HARNESS_CATALOG_STORAGE_KEY, expect.anything());
  });

  it("installs __cxpPetsStackMaxHeight and replays layout on storage change", () => {
    const { win } = setup();
    const dispose = installPetsStackHeightHook(win as unknown as Window, () => 700);
    disposers.push(dispose);
    const hook = win[CXP_PETS_STACK_MAX_HEIGHT_HOOK] as ((qc: unknown) => number) | undefined;
    expect(typeof hook).toBe("function");
    expect(hook?.({ workArea: { height: 900 } })).toBe(resolvePetsStackMaxHeight(700, { workArea: { height: 900 } }, 1000));
    expect(hook?.({ workArea: { height: 900 } })).toBe(660);
    expect(hook?.(null)).toBe(700);

    win.dispatchEvent(new MessageEvent("message", { data: { type: "avatar-overlay-layout-changed", x: 1 } }));
    const storageEvent = new Event("storage") as Event & { key: string };
    storageEvent.key = PETS_STACK_MAX_HEIGHT_STORAGE_KEY;
    win.dispatchEvent(storageEvent);
    expect(win.postedMessages).toEqual([{ type: "avatar-overlay-layout-changed", x: 1 }]);

    dispose();
    expect(win[CXP_PETS_STACK_MAX_HEIGHT_HOOK]).toBeUndefined();
  });
});

describe("Pet avatar-overlay UI & Quick Chat", () => {
  it("tags external Harness cards and renders icon stylesheet", () => {
    const { doc, find, install, seedCatalog } = setup();
    seedCatalog();
    install();
    expect(
      find('[data-avatar-overlay-activity-stack-item="local:local:ext-1"]').getAttribute(
        AVATAR_OVERLAY_CARD_AGENT_ATTR,
      ),
    ).toBe("claude-code");
    expect(
      find(
        '[data-avatar-overlay-activity-stack-item="remote-host:remote-ssh-discovered:mac-work:r-1"]',
      ).getAttribute(AVATAR_OVERLAY_CARD_AGENT_ATTR),
    ).toBe("claude-code");
    expect(
      find('[data-avatar-overlay-activity-stack-item="local:local:codex-1"]').getAttribute(
        AVATAR_OVERLAY_CARD_AGENT_ATTR,
      ),
    ).toBeNull();
    expect(doc.getElementById(AVATAR_OVERLAY_ICON_STYLE_ID)?.textContent).toContain("claude-code");
  });

  it("shows Quick Chat Agent pill only while composing and updates selected agent", async () => {
    const { doc, win, find, install, seedCatalog } = setup("minimized");
    seedCatalog();
    install();
    expect(doc.querySelector(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`)).toBeNull();

    find("[data-quick-chat-presentation]").setAttribute("data-quick-chat-presentation", "composing");
    await settle();
    const pill = find(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`);
    expect(pill.parentElement?.hasAttribute("data-above-composer-portal")).toBe(true);
    expect(pill.textContent).toBe("Codex");

    const mousedown = new Event("mousedown", { bubbles: true, cancelable: true });
    pill.dispatchEvent(mousedown);
    expect(mousedown.defaultPrevented).toBe(true);

    pill.click();
    const options = doc.querySelectorAll(`[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] [role="menuitemradio"]`);
    expect(
      options.map((o) => [o.getAttribute("data-agent-option"), o.getAttribute("aria-checked")]),
    ).toEqual([
      ["codex", "true"],
      ["claude-code", "false"],
    ]);
    options[1]?.click();
    expect(win.localStorage.getItem(PETS_QUICK_CHAT_AGENT_STORAGE_KEY)).toBe("claude-code");
    expect(doc.querySelector(`[${AVATAR_OVERLAY_AGENT_MENU_ATTR}]`)).toBeNull();
    await settle();
    expect(doc.querySelector(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`)?.textContent).toBe(
      "Claude Code",
    );
  });

  it("starts Quick Chat in a picked remote project with that host's Agents via __cxpQuickChatTarget", async () => {
    const { doc, win, find, install, seedCatalog } = setup("composing");
    seedCatalog();
    writePetsRemoteProjects(
      [
        {
          hostId: "remote-ssh:mac",
          hostLabel: "MacAir",
          hostColor: "#ffc300",
          projectId: "p1",
          label: "nook",
          path: "/Users/me/nook",
          agents: ["codex", "claude-code"],
        },
        {
          hostId: "remote-ssh:nas",
          hostLabel: "NAS",
          hostColor: null,
          projectId: "p2",
          label: "jobs",
          path: "/srv/jobs",
          agents: ["codex"],
        },
      ],
      win.localStorage as unknown as Storage,
    );
    install();
    const hook = () =>
      (win[CXP_QUICK_CHAT_TARGET_HOOK] as ((id: string) => unknown) | undefined)?.("c-1");
    expect(hook()).toBeUndefined();

    const openMenu = () => find(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`).click();
    const option = (attr: string, value: string) =>
      find(`[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] [${attr}="${value}"]`);
    openMenu();
    option("data-location-option", "remote-ssh:mac|p1").click();
    expect(hook()).toEqual({
      type: "remoteProject",
      hostId: "remote-ssh:mac",
      projectId: "p1",
      path: "/Users/me/nook",
      environment: { type: "local" },
      clientThreadId: "c-1",
    });
    option("data-agent-option", "claude-code").click();
    await settle();
    expect(find(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`).textContent).toBe("Claude Codenook");

    // A host without the selected Agent falls back to Codex.
    openMenu();
    option("data-location-option", "remote-ssh:nas|p2").click();
    expect(
      doc.querySelector(`[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] [data-agent-option="claude-code"]`),
    ).toBeNull();
    await settle();
    expect(find(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`).textContent).toBe("Codexjobs");

    option("data-location-option", "local").click();
    expect(hook()).toBeUndefined();
  });

  it("routes Quick Chat to the selected Harness and leaves Codex untouched", () => {
    const { win, install, seedCatalog, posted, FakeMessagePort } = setup();
    seedCatalog();
    const original = FakeMessagePort.prototype.postMessage;
    win.localStorage.setItem(PETS_QUICK_CHAT_AGENT_STORAGE_KEY, "claude-code");
    const handle = install();
    const frame = (model: string) => [
      "push",
      [
        "pipeline",
        0,
        ["startConversation"],
        [{ collaborationMode: { settings: { model } }, config: { model } }],
      ],
    ];
    const port = new FakeMessagePort();
    port.postMessage(frame("gpt-5.5"));
    const route = encodeHarnessPluginRoute({ harnessId: "claude-code" });
    expect(JSON.stringify(posted[0])).toContain(`"model":"${route}"`);
    expect(JSON.stringify(posted[0])).not.toContain("gpt-5.5");

    win.localStorage.setItem(PETS_QUICK_CHAT_AGENT_STORAGE_KEY, "codex");
    port.postMessage(frame("gpt-5.5"));
    expect(JSON.stringify(posted[1])).toContain('"model":"gpt-5.5"');

    handle.dispose();
    expect(FakeMessagePort.prototype.postMessage).toBe(original);
  });

  it("removes everything it added on dispose and leaves native nodes untouched", () => {
    const { doc, win, install, seedCatalog } = setup("composing");
    seedCatalog();
    const handle = install();
    expect(doc.documentElement.getAttribute(AVATAR_OVERLAY_ROOT_ATTR)).toBe("true");
    expect(doc.getElementById(AVATAR_OVERLAY_STYLE_ID)).not.toBeNull();
    expect(doc.querySelector(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`)).not.toBeNull();
    expect(win[CXP_QUICK_CHAT_TARGET_HOOK]).toBeTypeOf("function");

    handle.dispose();
    expect(doc.documentElement.getAttribute(AVATAR_OVERLAY_ROOT_ATTR)).toBeNull();
    expect(doc.getElementById(AVATAR_OVERLAY_STYLE_ID)).toBeNull();
    expect(doc.getElementById(AVATAR_OVERLAY_ICON_STYLE_ID)).toBeNull();
    expect(doc.querySelector(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`)).toBeNull();
    expect(doc.querySelector(`[${AVATAR_OVERLAY_CARD_AGENT_ATTR}]`)).toBeNull();
    expect(win[CXP_QUICK_CHAT_TARGET_HOOK]).toBeUndefined();
  });
});
