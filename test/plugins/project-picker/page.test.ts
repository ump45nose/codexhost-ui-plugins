import { describe, expect, it, vi } from "vitest";
import manifest from "../../../plugins/project-picker/plugin.ts";
import {
  installProjectPickerPage,
  normalizeProjectRootPaths,
  reconcileDuplicateLocalProjects,
  resolvePreferredProjectParentDirectory,
  wrapProjectsWithDeduplication,
  wrapWorkspaceFilesWithDefaultDirectory,
  type BrowseDirectoryRequest,
  type BrowseDirectoryResponse,
  type NativeLocalProjectEntry,
  type NativeProjectsService,
  type NativeWorkspaceFiles,
  type NativeWorkspaceFilesServices,
} from "../../../plugins/project-picker/page.ts";
import type { PluginApi } from "../../../plugins/types.ts";

class FakeWindow extends EventTarget {
  location = { href: "app://-/index.html" };
  document = {
    querySelectorAll: () => [],
  };
  postedMessages: unknown[] = [];
  private listenerCounts = new Map<string, number>();
  [key: string]: unknown;

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener, options);
    this.listenerCounts.set(type, (this.listenerCounts.get(type) ?? 0) + 1);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, listener, options);
    const next = Math.max(0, (this.listenerCounts.get(type) ?? 0) - 1);
    if (next === 0) this.listenerCounts.delete(type);
    else this.listenerCounts.set(type, next);
  }

  get activeListenerCount(): number {
    let total = 0;
    for (const count of this.listenerCounts.values()) total += count;
    return total;
  }

  postMessage(data: unknown): void {
    this.postedMessages.push(data);
  }

  emitMessage(data: unknown): void {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }
}

function createFakeApi(settings: Record<string, unknown> = {}) {
  const requests: Array<{ method: string; params: unknown }> = [];
  const logs: unknown[][] = [];
  const failures: string[] = [];
  const api: PluginApi = {
    id: "project-picker",
    window: "main",
    settings,
    request: async (method, params) => {
      requests.push({ method, params });
      return { directory: settings.defaultDirectory ?? null };
    },
    fail: (reason) => failures.push(reason),
    log: (...args) => logs.push(args),
  };
  return { api, requests, logs, failures };
}

function createFakeServices(initial: {
  projects?: Record<string, NativeLocalProjectEntry>;
  order?: string[];
  selection?: { type: string; projectId: string } | null;
  assignments?: Record<string, { projectKind?: string; projectId?: string; hostId?: string }>;
  existingDirs?: Set<string>;
  homeDir?: string;
} = {}) {
  const projectsMap: Record<string, NativeLocalProjectEntry> = { ...(initial.projects ?? {}) };
  let order = [...(initial.order ?? Object.keys(projectsMap))];
  let selection = initial.selection ?? null;
  const assignments = { ...(initial.assignments ?? {}) };
  const removedIds: string[] = [];
  const orderWrites: string[][] = [];
  const stateWrites: Array<{ key: string; value: unknown }> = [];
  const assignmentWrites: Array<{ threadId: string; projectId: string }> = [];
  const invalidatedKeys: unknown[][] = [];
  const browseCalls: BrowseDirectoryRequest[] = [];
  const createLocalCalls: Array<{ sources: readonly string[]; setActive?: boolean }> = [];
  let createdSeq = 0;

  const homeDir = initial.homeDir ?? "/Users/tester";
  const existingDirs = initial.existingDirs ?? new Set([homeDir, `${homeDir}/Developer/Repos/Personal`]);

  const workspaceFiles: NativeWorkspaceFiles = {
    browseDirectory: (params) => {
      browseCalls.push(params);
      const targetPath =
        typeof params.directoryPath === "string" && params.directoryPath.trim().length > 0
          ? params.directoryPath
          : homeDir;
      if (!existingDirs.has(targetPath)) {
        return Promise.reject(new Error(`ENOENT: ${targetPath}`));
      }
      const response: BrowseDirectoryResponse = {
        directoryPath: targetPath,
        entries: [],
      };
      return Promise.resolve(response);
    },
  };

  const projects: NativeProjectsService = {
    createLocal: (params) => {
      createLocalCalls.push({ sources: params.sources, setActive: params.setActive });
      const id = `created-${++createdSeq}`;
      projectsMap[id] = {
        id,
        name: params.name ?? id,
        rootPaths: [...params.sources],
        createdAt: 1000 + createdSeq,
      };
      return Promise.resolve({ projectId: id, rootPaths: [...params.sources] });
    },
    removeLocal: (projectId) => {
      removedIds.push(projectId);
      delete projectsMap[projectId];
      return Promise.resolve({ ok: true });
    },
    setProjectOrder: (nextOrder) => {
      order = [...nextOrder];
      orderWrites.push([...nextOrder]);
      return Promise.resolve({ ok: true });
    },
  };

  const services: NativeWorkspaceFilesServices = {
    workspaceFiles,
    projects,
    projectCatalog: {
      readLocalProjects: () => Promise.resolve({ ...projectsMap }),
      readSelection: () => Promise.resolve(selection),
    },
    projectPresentation: {
      readOrder: () => Promise.resolve([...order]),
    },
    applicationState: {
      read: (key) => {
        if (key === "local-projects") return Promise.resolve({ value: { ...projectsMap } });
        return Promise.resolve(undefined);
      },
      write: (key, value) => {
        stateWrites.push({ key, value });
        if (key === "selected-project") {
          selection = value as { type: string; projectId: string } | null;
        }
        return Promise.resolve({ success: true });
      },
    },
    threadProjectAssignments: {
      readMemberships: () => Promise.resolve({ assignments: { ...assignments } }),
      setAssignment: ({ threadId, assignment }) => {
        if (assignment) {
          assignments[threadId] = assignment;
          assignmentWrites.push({ threadId, projectId: assignment.projectId });
        }
        return Promise.resolve({ ok: true });
      },
    },
    queryCache: {
      invalidateQueryCache: ({ queryKey }) => {
        invalidatedKeys.push([...queryKey]);
        return Promise.resolve({ ok: true });
      },
    },
  };

  return {
    services,
    originalWorkspaceFiles: workspaceFiles,
    originalProjects: projects,
    projectsMap,
    getOrder: () => order,
    getSelection: () => selection,
    assignments,
    removedIds,
    orderWrites,
    stateWrites,
    assignmentWrites,
    invalidatedKeys,
    browseCalls,
    createLocalCalls,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("plugins/project-picker manifest", () => {
  it("declares main window, page entry, forkGuard, task, and defaultDirectory setting", () => {
    expect(manifest.id).toBe("project-picker");
    expect(manifest.windows).toEqual(["main"]);
    expect(manifest.page).toBe("./page.ts");
    expect(manifest.forkGuards).toEqual(["__codexhostMacOpenPanelResetNonceV1"]);
    expect(typeof manifest.task).toBe("function");
    expect(manifest.settings?.[0]?.key).toBe("defaultDirectory");
  });
});

describe("project deduplication (C2.7)", () => {
  it("normalizes root paths by trimming, stripping trailing slashes, and deduplicating", () => {
    expect(normalizeProjectRootPaths([" /a/b/// ", "/a/b", "/", "///", ""])).toEqual([
      "/a/b",
      "/",
      "",
    ].filter(Boolean));
  });

  it("reconciles duplicate local projects, merging thread assignments, project order, and selection into the earliest project", async () => {
    const win = new FakeWindow();
    const fake = createFakeServices({
      projects: {
        "proj-newer": {
          id: "proj-newer",
          name: "Repo (dup)",
          rootPaths: ["/Users/tester/Developer/Repos/Personal/demo/"],
          createdAt: 200,
        },
        "proj-canonical": {
          id: "proj-canonical",
          name: "Repo",
          rootPaths: ["/Users/tester/Developer/Repos/Personal/demo"],
          createdAt: 100,
        },
        "proj-other": {
          id: "proj-other",
          name: "Other",
          rootPaths: ["/Users/tester/Developer/Repos/Personal/other"],
          createdAt: 150,
        },
      },
      order: ["proj-newer", "proj-other", "proj-canonical"],
      selection: { type: "local", projectId: "proj-newer" },
      assignments: {
        "thread-1": { projectKind: "local", projectId: "proj-newer" },
        "thread-2": { projectKind: "local", projectId: "proj-other" },
        "thread-remote": { projectKind: "remote", projectId: "proj-newer", hostId: "nas" },
      },
    });

    const modified = await reconcileDuplicateLocalProjects(
      fake.services,
      win as unknown as Window,
    );

    expect(modified).toBe(true);
    expect(fake.removedIds).toEqual(["proj-newer"]);
    expect(Object.keys(fake.projectsMap)).toEqual(["proj-canonical", "proj-other"]);
    expect(fake.assignmentWrites).toEqual([{ threadId: "thread-1", projectId: "proj-canonical" }]);
    expect(fake.assignments["thread-2"]?.projectId).toBe("proj-other");
    expect(fake.assignments["thread-remote"]?.projectId).toBe("proj-newer");
    expect(fake.getOrder()).toEqual(["proj-canonical", "proj-other"]);
    expect(fake.getSelection()).toEqual({ type: "local", projectId: "proj-canonical" });
    expect(win.postedMessages).toContainEqual(
      expect.objectContaining({ type: "global-state-updated" }),
    );
    expect(win.postedMessages).toContainEqual({ type: "workspace-root-options-updated" });
    expect(fake.invalidatedKeys).toEqual([
      ["vscode", "get-global-state"],
      ["workspace-root-options"],
    ]);
  });

  it("intercepts createLocal for an existing root path instead of creating a duplicate", async () => {
    const win = new FakeWindow();
    const fake = createFakeServices({
      projects: {
        "proj-1": {
          id: "proj-1",
          name: "Demo",
          rootPaths: ["/Users/tester/Developer/Repos/Personal/demo"],
          createdAt: 100,
        },
        "proj-2": {
          id: "proj-2",
          name: "Other",
          rootPaths: ["/Users/tester/Developer/Repos/Personal/other"],
          createdAt: 200,
        },
      },
      order: ["proj-2", "proj-1"],
    });

    const wrapped = wrapProjectsWithDeduplication(
      fake.originalProjects,
      fake.services,
      win as unknown as Window,
    );
    fake.services.projects = wrapped;

    const result = await wrapped.createLocal({
      sources: ["/Users/tester/Developer/Repos/Personal/demo/"],
      setActive: true,
    });

    expect(result).toEqual({
      projectId: "proj-1",
      rootPaths: ["/Users/tester/Developer/Repos/Personal/demo"],
    });
    expect(fake.createLocalCalls).toEqual([]);
    expect(fake.getSelection()).toEqual({ type: "local", projectId: "proj-1" });
    expect(fake.getOrder()).toEqual(["proj-1", "proj-2"]);

    // Creating a project with a brand-new directory still delegates to the native service.
    const created = await wrapped.createLocal({
      sources: ["/Users/tester/Developer/Repos/Personal/brand-new"],
    });
    expect(created?.projectId).toBe("created-1");
    expect(fake.createLocalCalls).toHaveLength(1);
  });
});

describe("default directory & applyDefaultDirectory lifecycle (C2.8)", () => {
  it("resolves preferred directory for tilde subpath and local absolute paths", () => {
    expect(
      resolvePreferredProjectParentDirectory("/Users/tester", "~/Developer/Repos/Personal"),
    ).toBe("/Users/tester/Developer/Repos/Personal");
    expect(
      resolvePreferredProjectParentDirectory("/home/nas", "~/Developer/Repos/Personal", "nas"),
    ).toBe("/home/nas/Developer/Repos/Personal");
    expect(
      resolvePreferredProjectParentDirectory("/Users/tester", "/opt/work/", "local"),
    ).toBe("/opt/work");
    expect(
      resolvePreferredProjectParentDirectory("/home/nas", "/opt/work", "nas"),
    ).toBeNull();
    expect(resolvePreferredProjectParentDirectory("/Users/tester", "")).toBeNull();
  });

  it("redirects empty-path browseDirectory to configured default directory and falls back when absent", async () => {
    const fake = createFakeServices({
      homeDir: "/Users/tester",
      existingDirs: new Set(["/Users/tester", "/Users/tester/Developer/Repos/Personal"]),
    });
    const onDefaultBrowse = vi.fn();
    const wrapped = wrapWorkspaceFilesWithDefaultDirectory(
      fake.originalWorkspaceFiles,
      "~/Developer/Repos/Personal",
      onDefaultBrowse,
    );

    const first = await wrapped.browseDirectory({ directoryPath: null });
    expect(first.directoryPath).toBe("/Users/tester/Developer/Repos/Personal");
    expect(onDefaultBrowse).toHaveBeenCalledWith("local");

    // Second call uses the cached preferred directory directly.
    const second = await wrapped.browseDirectory({});
    expect(second.directoryPath).toBe("/Users/tester/Developer/Repos/Personal");

    // Explicit directoryPath bypasses default redirect.
    const explicit = await wrapped.browseDirectory({ directoryPath: "/Users/tester" });
    expect(explicit.directoryPath).toBe("/Users/tester");

    // Missing preferred directory falls back to home directory.
    const missingWrapped = wrapWorkspaceFilesWithDefaultDirectory(
      fake.originalWorkspaceFiles,
      "~/Does/Not/Exist",
    );
    const fallback = await missingWrapped.browseDirectory({ directoryPath: "" });
    expect(fallback.directoryPath).toBe("/Users/tester");
  });

  it("requests applyDefaultDirectory on activate and picker reset messages, reconciles duplicates, and cleans up completely", async () => {
    const win = new FakeWindow();
    const fake = createFakeServices({
      projects: {
        "p-old": { id: "p-old", name: "App", rootPaths: ["/Users/tester/app"], createdAt: 10 },
        "p-dup": { id: "p-dup", name: "App", rootPaths: ["/Users/tester/app/"], createdAt: 20 },
      },
      order: ["p-dup", "p-old"],
      assignments: {
        "t-1": { projectKind: "local", projectId: "p-dup" },
      },
    });

    // Expose services via webpack runtime cache through __codexhostLoadedModulesV1.
    const webpackRequire = Object.assign(() => undefined, {
      c: {
        mod1: {
          exports: Object.defineProperty({}, "services", {
            value: fake.services,
            enumerable: true,
            configurable: false,
          }),
        },
      },
    });
    win.__codexhostLoadedModulesV1 = {
      complete: true,
      documentUrl: "app://-/index.html",
      urls: ["app://-/assets/app-shared-123.js"],
    };

    const { api, requests } = createFakeApi({
      defaultDirectory: "~/Developer/Repos/Personal",
    });

    const dispose = installProjectPickerPage(api, {
      ownerWindow: win as unknown as Window,
      importModule: async () => ({ __webpack_require__: webpackRequire }),
      retryIntervalMs: 0,
    });

    await flush();

    // 1. Activation discovered & wrapped native services and reconciled duplicates
    //    without redundant applyDefaultDirectory (task.ts already writes it at startup).
    expect(requests).toEqual([]);
    expect(fake.services.workspaceFiles).not.toBe(fake.originalWorkspaceFiles);
    expect(fake.services.projects).not.toBe(fake.originalProjects);
    expect(fake.removedIds).toEqual(["p-dup"]);
    expect(fake.assignmentWrites).toEqual([{ threadId: "t-1", projectId: "p-old" }]);

    // 2. After picking/adding/canceling a folder, applyDefaultDirectory is requested again so
    //    the next picker open still defaults to the configured directory.
    win.emitMessage({ type: "workspace-root-option-picked" });
    win.emitMessage({ type: "workspace-root-option-added" });
    win.emitMessage({ type: "workspace-root-option-add-canceled" });
    expect(requests.map((r) => r.method)).toEqual([
      "applyDefaultDirectory",
      "applyDefaultDirectory",
      "applyDefaultDirectory",
    ]);

    // 3. Local empty-path browseDirectory also triggers applyDefaultDirectory and redirects.
    const listed = await fake.services.workspaceFiles.browseDirectory({ directoryPath: null });
    expect(listed.directoryPath).toBe("/Users/tester/Developer/Repos/Personal");
    expect(requests).toHaveLength(4);

    // 4. Disposing restores original native services and removes all listeners.
    expect(win.activeListenerCount).toBe(3);
    dispose();
    expect(win.activeListenerCount).toBe(0);
    expect(fake.services.workspaceFiles).toBe(fake.originalWorkspaceFiles);
    expect(fake.services.projects).toBe(fake.originalProjects);

    // Subsequent messages after dispose do nothing.
    win.emitMessage({ type: "workspace-root-option-picked" });
    expect(requests).toHaveLength(4);

    // Re-activating with updated settings works cleanly (idempotent dispose + fresh activation).
    dispose();
    win.postedMessages = [];
    const { api: api2, requests: requests2 } = createFakeApi({ defaultDirectory: "" });
    const dispose2 = installProjectPickerPage(api2, {
      ownerWindow: win as unknown as Window,
      importModule: async () => ({ __webpack_require__: webpackRequire }),
      retryIntervalMs: 0,
    });
    await flush();

    // Empty defaultDirectory skips applyDefaultDirectory and leaves workspaceFiles unwrapped,
    // while still wrapping projects for deduplication; no duplicates -> no global-state-updated.
    expect(requests2).toEqual([]);
    expect(win.postedMessages).toEqual([]);
    expect(fake.services.workspaceFiles).toBe(fake.originalWorkspaceFiles);
    expect(fake.services.projects).not.toBe(fake.originalProjects);

    dispose2();
    expect(fake.services.projects).toBe(fake.originalProjects);
    expect(win.activeListenerCount).toBe(0);
  });

  it("calls api.fail when service discovery throws or exhausts 15 retries", async () => {
    // 1. Catalog error with retryIntervalMs: 0 -> fails immediately with error message.
    const win1 = new FakeWindow();
    win1.__codexhostLoadedModulesV1 = { complete: false };
    const { api: api1, failures: failures1 } = createFakeApi({});
    const dispose1 = installProjectPickerPage(api1, {
      ownerWindow: win1 as unknown as Window,
      retryIntervalMs: 0,
    });
    await flush();
    expect(failures1).toHaveLength(1);
    expect(failures1[0]).toContain("catalog is unavailable");
    dispose1();

    // 2. Missing services after 15 retries -> calls api.fail once.
    vi.useFakeTimers();
    try {
      const win2 = new FakeWindow();
      const { api: api2, failures: failures2 } = createFakeApi({});
      const dispose2 = installProjectPickerPage(api2, {
        ownerWindow: win2 as unknown as Window,
        retryIntervalMs: 10,
      });
      for (let i = 0; i < 16; i++) {
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(failures2).toHaveLength(1);
      expect(failures2[0]).toContain("未找到 Codex 原生项目服务");
      dispose2();
    } finally {
      vi.useRealTimers();
    }
  });
});
