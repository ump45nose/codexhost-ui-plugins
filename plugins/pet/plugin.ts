// Pet plugin manifest (Node-side via type stripping: strictly erasable TS syntax only).

import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginManifest, TaskContext } from "../types.ts";
import { petRewrites } from "./rewrites.ts";

interface DesktopRemoteProjectRecord {
  readonly id: string;
  readonly hostId: string;
  readonly name: string;
  readonly path: string;
}

/** Reads Desktop's persisted `remote-projects` from `.codex-global-state.json` (read-only). */
export async function readDesktopRemoteProjects(
  file = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), ".codex-global-state.json"),
): Promise<DesktopRemoteProjectRecord[]> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return [];
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return [];
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) return [];
    const state = JSON.parse(text) as Record<string, unknown>;
    const projects = state["remote-projects"];
    if (!Array.isArray(projects)) return [];
    const order = Array.isArray(state["project-order"])
      ? (state["project-order"] as unknown[])
      : [];
    return projects
      .flatMap((p: unknown): DesktopRemoteProjectRecord[] => {
        if (!p || typeof p !== "object") return [];
        const v = p as Record<string, unknown>;
        if (
          typeof v.id !== "string" ||
          typeof v.hostId !== "string" ||
          typeof v.remotePath !== "string" ||
          typeof v.label !== "string" ||
          (order.length > 0 && !order.includes(v.id))
        ) {
          return [];
        }
        return [{ id: v.id, hostId: v.hostId, name: v.label, path: v.remotePath }];
      })
      .sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
      });
  } catch {
    return [];
  } finally {
    await handle.close();
  }
}

function petTask(ctx: TaskContext): () => void {
  ctx.onRequest("remoteProjects/list", () => readDesktopRemoteProjects());
  return () => {};
}

const manifest: PluginManifest = {
  id: "pet",
  name: "Pet",
  windows: ["pet"],
  page: "./page.ts",
  rewrites: petRewrites,
  forkGuards: [
    "__codexhostAvatarOverlayV1",
    "__codexhostPetsStackMaxHeight",
    "__codexhostQuickChatTarget",
    "__codexhostPetsStackPatched",
  ],
  task: petTask,
  settings: [
    {
      key: "stackMaxHeight",
      type: "number",
      label: "Pet 会话栈最大高度 (px)",
      default: 600,
      min: 200,
      max: 1600,
      step: 20,
    },
    {
      key: "remoteSessions",
      type: "toggle",
      label: "显示远端无项目会话",
      default: true,
    },
    {
      key: "quickChatTarget",
      type: "toggle",
      label: "Quick Chat 远端项目与 Agent 选择",
      default: true,
    },
    {
      key: "cardAgents",
      type: "toggle",
      label: "卡片显示外部 Agent 图标",
      default: true,
    },
  ],
};

export default manifest;
