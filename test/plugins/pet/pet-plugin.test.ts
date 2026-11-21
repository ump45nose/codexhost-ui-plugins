import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginApi } from "../../../plugins/types.ts";
import {
  AVATAR_OVERLAY_AGENT_MENU_ATTR,
  AVATAR_OVERLAY_AGENT_PILL_ATTR,
  AVATAR_OVERLAY_CARD_AGENT_ATTR,
  AVATAR_OVERLAY_ROOT_ATTR,
  AVATAR_OVERLAY_STYLE_ID,
} from "../../../plugins/pet/avatar-overlay/index.ts";
import activate from "../../../plugins/pet/page.ts";
import manifest, { readDesktopRemoteProjects } from "../../../plugins/pet/plugin.ts";
import {
  CXP_PETS_STACK_MAX_HEIGHT_HOOK,
  CXP_QUICK_CHAT_TARGET_HOOK,
} from "../../../plugins/pet/rewrites.ts";
import { FakeDocument, FakeWindow, installFakeMutationObserver } from "./fake-dom.ts";

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  delete (globalThis as Record<string, unknown>).__codexhostHostRoutingV1;
});

function makeApi(
  settings: Record<string, unknown> = {},
  requestImpl?: (method: string, params?: unknown) => Promise<unknown>,
): PluginApi {
  return {
    id: "pet",
    window: "pet",
    settings,
    request: requestImpl ?? (async () => []),
    fail: vi.fn(),
    log: vi.fn(),
  };
}

describe("pet plugin manifest & daemon task", () => {
  it("declares pet window, rewrites, forkGuards, and settings", () => {
    expect(manifest.id).toBe("pet");
    expect(manifest.windows).toEqual(["pet"]);
    expect(manifest.page).toBe("./page.ts");
    expect(manifest.rewrites?.map((r) => r.name)).toEqual([
      "pet-stack-max-height",
      "pet-quick-chat-target",
      "pet-client-thread-link",
    ]);
    expect(manifest.forkGuards).toEqual([
      "__codexhostAvatarOverlayV1",
      "__codexhostPetsStackMaxHeight",
      "__codexhostQuickChatTarget",
      "__codexhostPetsStackPatched",
    ]);
    expect(manifest.settings?.map((s) => s.key)).toEqual([
      "stackMaxHeight",
      "remoteSessions",
      "quickChatTarget",
      "cardAgents",
    ]);
  });

  it("reads Desktop remote-projects ordered by project-order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cxp-pet-projects-"));
    disposers.push(() => void rm(dir, { recursive: true, force: true }));
    const file = join(dir, ".codex-global-state.json");
    await writeFile(
      file,
      JSON.stringify({
        "project-order": ["p2", "p1"],
        "remote-projects": [
          { id: "p1", hostId: "remote-ssh:nas", label: "media", remotePath: "/volume1/media" },
          { id: "p2", hostId: "remote-ssh:mac", label: "nook", remotePath: "/Users/me/nook" },
          { id: "orphan", hostId: "remote-ssh:nas", label: "old", remotePath: "/old" },
        ],
      }),
    );
    expect(await readDesktopRemoteProjects(file)).toEqual([
      { id: "p2", hostId: "remote-ssh:mac", name: "nook", path: "/Users/me/nook" },
      { id: "p1", hostId: "remote-ssh:nas", name: "media", path: "/volume1/media" },
    ]);
  });
});

describe("pet plugin page activate() & Host RPC integration", () => {
  it("resolves card agents via codexhost/thread/ownership/list and remote projects via Host RPCs", async () => {
    disposers.push(installFakeMutationObserver());
    const doc = new FakeDocument();
    const win = new FakeWindow(doc);

    const card = doc.createElement("div");
    card.setAttribute("data-avatar-overlay-activity-stack-item", "remote-host:remote-ssh:nas:t-42");
    const title = doc.createElement("div");
    title.setAttribute("data-avatar-overlay-activity-text", "title");
    title.textContent = "NAS Job";
    card.appendChild(title);
    doc.body.appendChild(card);

    const qc = doc.createElement("div");
    qc.setAttribute("data-quick-chat-presentation", "composing");
    const portal = doc.createElement("div");
    portal.setAttribute("data-above-composer-portal", "true");
    qc.appendChild(portal);
    doc.body.appendChild(qc);

    const sendRequest = vi.fn(async (host: string, method: string, params?: unknown) => {
      if (host === "local" && method === "codexhost/console/remote-connections") {
        return [{ hostId: "remote-ssh:nas", displayName: "nas.local", sshAlias: "nas", sshHost: "10.0.0.2" }];
      }
      if (host === "local" && method === "codexhost/harness/plugins/list") {
        return { plugins: [{ id: "claude-code", name: "Claude Code" }] };
      }
      if (host === "remote-ssh:nas" && method === "codexhost/harness/plugins/list") {
        return { plugins: [{ id: "claude-code", name: "Claude Code" }] };
      }
      if (host === "remote-ssh:nas" && method === "codexhost/workspace/read") {
        return {
          projects: [{ id: "nas-p1", name: "jobs", rootPaths: ["/srv/jobs"] }],
          assignments: {},
          projectless: [],
          pinned: [],
        };
      }
      if (host === "remote-ssh:nas" && method === "codexhost/thread/ownership/list") {
        expect(params).toEqual({ threadIds: ["t-42"] });
        return { threads: [{ threadId: "t-42", owner: "claude-code" }] };
      }
      return {};
    });

    (globalThis as Record<string, unknown>).__codexhostHostRoutingV1 = {
      knownHostIds: () => ["local", "remote-ssh:nas"],
      forHost: (host: string) => ({
        manager: {
          sendRequest: (method: string, params?: unknown) => sendRequest(host, method, params),
        },
      }),
    };

    const cleanup = activate(
      makeApi({ stackMaxHeight: 720, remoteSessions: false, quickChatTarget: true, cardAgents: true }),
      { document: doc as unknown as Document, window: win as unknown as Window, syncIntervalMs: 0 },
    );
    disposers.push(cleanup);

    await new Promise((r) => setTimeout(r, 30));

    // Stack max height hook uses setting value.
    const heightHook = win[CXP_PETS_STACK_MAX_HEIGHT_HOOK] as ((qc: unknown) => number) | undefined;
    expect(heightHook?.(null)).toBe(720);

    // Card agent resolved via codexhost/thread/ownership/list.
    expect(card.getAttribute(AVATAR_OVERLAY_CARD_AGENT_ATTR)).toBe("claude-code");

    // Quick Chat menu shows remote project fetched from Host RPC.
    const pill = doc.querySelector(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`);
    expect(pill).not.toBeNull();
    pill!.click();
    const nasOption = doc.querySelector(
      `[${AVATAR_OVERLAY_AGENT_MENU_ATTR}] [data-location-option="remote-ssh:nas|nas-p1"]`,
    );
    expect(nasOption).not.toBeNull();
    nasOption!.click();

    const targetHook = win[CXP_QUICK_CHAT_TARGET_HOOK] as ((id: string) => unknown) | undefined;
    expect(targetHook?.("client-1")).toEqual({
      type: "remoteProject",
      hostId: "remote-ssh:nas",
      projectId: "nas-p1",
      path: "/srv/jobs",
      environment: { type: "local" },
      clientThreadId: "client-1",
    });

    // Full cleanup removes DOM, styles, and global hooks.
    cleanup();
    expect(doc.documentElement.getAttribute(AVATAR_OVERLAY_ROOT_ATTR)).toBeNull();
    expect(doc.getElementById(AVATAR_OVERLAY_STYLE_ID)).toBeNull();
    expect(win[CXP_PETS_STACK_MAX_HEIGHT_HOOK]).toBeUndefined();
    expect(win[CXP_QUICK_CHAT_TARGET_HOOK]).toBeUndefined();
  });

  it("honors quickChatTarget=false and cardAgents=false settings", () => {
    disposers.push(installFakeMutationObserver());
    const doc = new FakeDocument();
    const win = new FakeWindow(doc);
    const qc = doc.createElement("div");
    qc.setAttribute("data-quick-chat-presentation", "composing");
    const portal = doc.createElement("div");
    portal.setAttribute("data-above-composer-portal", "true");
    qc.appendChild(portal);
    doc.body.appendChild(qc);

    const cleanup = activate(
      makeApi({ remoteSessions: false, quickChatTarget: false, cardAgents: false }),
      { document: doc as unknown as Document, window: win as unknown as Window, syncIntervalMs: 0 },
    );
    disposers.push(cleanup);

    expect(doc.querySelector(`[${AVATAR_OVERLAY_AGENT_PILL_ATTR}]`)).toBeNull();
    expect(win[CXP_QUICK_CHAT_TARGET_HOOK]).toBeUndefined();
    expect(win[CXP_PETS_STACK_MAX_HEIGHT_HOOK]).toBeTypeOf("function");

    cleanup();
    expect(win[CXP_PETS_STACK_MAX_HEIGHT_HOOK]).toBeUndefined();
  });
});
