// Project picker page plugin: deduplicates local projects sharing normalized rootPaths and keeps
// Desktop's folder picker pointed at `settings.defaultDirectory`.
// Ported from codex-host fork (`codex-project-default-directory.ts` + `codex-native-services.ts`).

import type { PluginApi } from "../types.ts";

export const ACCOUNT_SCOPED_GLOBAL_STATE_KEYS = [
  "local-projects", "selected-project", "project-appearances", "pinned-thread-ids",
  "pinned-project-ids", "sidebar-project-thread-orders", "sidebar-thread-metadata",
  "thread-project-assignments", "thread-workspace-root-hints", "projectless-thread-ids",
  "remote-projects", "project-order", "connection-group-order",
  "remote-cwds-by-host-and-workspace",
] as const;

export const OPEN_PANEL_RESET_MESSAGE_TYPES = new Set([
  "workspace-root-option-picked",
  "workspace-root-option-added",
  "workspace-root-option-add-canceled",
]);

const REFRESH_MESSAGE_TYPES = new Set([
  "persisted-atom-sync",
  "codex-app-server-initialized",
  "codex-app-server-connection-changed",
]);

const WRAPPED_FILES_SYM = Symbol.for("cxp.workspaceFilesDefaultDirectoryWrappedV1");
const WRAPPED_PROJECTS_SYM = Symbol.for("cxp.projectsDeduplicationWrappedV1");
const DISPOSE_SYM: symbol = (Symbol as { readonly dispose?: symbol }).dispose ?? Symbol.for("Symbol.dispose");
const COMPILED_EXPORT_GETTER =
  /^(?:\(\)=>|function\(\)\{return )[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[(?:[A-Za-z_$][\w$]*|"[^"\\]*"|'[^'\\]*')\])*\}?$/;

export type NativeDisposablePromise<T> = Promise<T> & { [Symbol.dispose]?: () => void };
export interface BrowseDirectoryRequest { readonly hostId?: string; readonly directoryPath?: string | null; readonly [k: string]: unknown }
export interface BrowseDirectoryResponse { readonly directoryPath: string; readonly [k: string]: unknown }
export interface NativeWorkspaceFiles { browseDirectory(p: BrowseDirectoryRequest): NativeDisposablePromise<BrowseDirectoryResponse>; readonly [k: string]: unknown }
export interface NativeLocalProjectEntry { readonly id: string; readonly name: string; readonly rootPaths: readonly string[]; readonly createdAt?: number; readonly [k: string]: unknown }
export interface CreateLocalProjectRequest { readonly name?: string; readonly sources: readonly string[]; readonly setActive?: boolean; readonly [k: string]: unknown }
export interface CreateLocalProjectResponse { readonly projectId: string; readonly rootPaths: readonly string[] }
export interface NativeProjectsService {
  createLocal(p: CreateLocalProjectRequest): NativeDisposablePromise<CreateLocalProjectResponse | null>;
  removeLocal?(projectId: string): NativeDisposablePromise<unknown>;
  setProjectOrder?(order: readonly string[]): NativeDisposablePromise<unknown>;
  readonly [k: string]: unknown;
}
export interface NativeWorkspaceFilesServices {
  workspaceFiles: NativeWorkspaceFiles;
  projects?: NativeProjectsService;
  projectCatalog?: {
    readLocalProjects?(): NativeDisposablePromise<Record<string, NativeLocalProjectEntry> | undefined>;
    readSelection?(): NativeDisposablePromise<{ readonly type: string; readonly projectId: string } | null | undefined>;
  };
  projectPresentation?: { readOrder?(): NativeDisposablePromise<readonly string[] | undefined> };
  applicationState?: {
    read?(key: string): NativeDisposablePromise<{ readonly value: unknown } | undefined>;
    write?(key: string, value: unknown): NativeDisposablePromise<{ readonly success?: boolean }>;
  };
  threadProjectAssignments?: {
    readMemberships?(): NativeDisposablePromise<{
      readonly assignments?: Record<string, { readonly projectKind?: string; readonly projectId?: string; readonly hostId?: string }>;
    }>;
    setAssignment?(p: { readonly threadId: string; readonly assignment: { readonly projectKind: string; readonly projectId: string; readonly hostId?: string } | null }): NativeDisposablePromise<unknown>;
  };
  queryCache?: { invalidateQueryCache?(p: { readonly queryKey: readonly unknown[] }): NativeDisposablePromise<unknown> };
}
export interface InstallProjectPickerPageOptions {
  ownerWindow?: Window;
  importModule?: (url: string) => Promise<Record<string, unknown>>;
  retryIntervalMs?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isObjectLike = (v: unknown): v is object => (typeof v === "object" || typeof v === "function") && v !== null;
const byCreatedAt = (a: NativeLocalProjectEntry, b: NativeLocalProjectEntry): number =>
  (typeof a.createdAt === "number" ? a.createdAt : Number.MAX_SAFE_INTEGER) -
  (typeof b.createdAt === "number" ? b.createdAt : Number.MAX_SAFE_INTEGER);

const attachDisposable = <T>(promise: Promise<T>, dispose: () => void): NativeDisposablePromise<T> =>
  Object.defineProperty(promise as NativeDisposablePromise<T>, DISPOSE_SYM, { value: dispose, configurable: true });

function getRequestDisposer(req: unknown): (() => void) | undefined {
  const fn = isObjectLike(req) ? Reflect.get(req, DISPOSE_SYM) : undefined;
  if (typeof fn !== "function") return undefined;
  return () => { try { Reflect.apply(fn, req, []); } catch { /* ignore */ } };
}

function compiledExportValues(mod: unknown): unknown[] {
  if (!isObjectLike(mod) || Object.hasOwn(mod, "error")) return [];
  const exp = Object.getOwnPropertyDescriptor(mod, "exports")?.value as unknown;
  if (typeof exp !== "object" || exp === null) return [];
  const proto: unknown = Object.getPrototypeOf(exp);
  if (proto !== Object.prototype && proto !== null) return [];
  const values: unknown[] = [];
  for (const d of Object.values(Object.getOwnPropertyDescriptors(exp))) {
    if (!d.enumerable || d.configurable) continue;
    if ("value" in d) values.push(d.value);
    else if (d.get) {
      try {
        if (COMPILED_EXPORT_GETTER.test(Function.prototype.toString.call(d.get))) values.push(d.get.call(exp));
      } catch { /* TDZ */ }
    }
  }
  return values;
}

/** Discovers Desktop's native services from loaded ES/webpack modules via `__codexhostLoadedModulesV1`. */
export async function loadCodexNativeServices<T>(
  ownerWindow: Window,
  matchesServices: (value: unknown) => value is T,
  importModule: (url: string) => Promise<Record<string, unknown>> = (url) => import(url),
): Promise<T | null> {
  if (!ownerWindow.document || !ownerWindow.location) return null;
  const page = new URL(ownerWindow.location.href);
  const catalog: unknown = Reflect.get(ownerWindow, "__codexhostLoadedModulesV1");
  let sources: string[];
  if (catalog !== undefined) {
    if (
      !isRecord(catalog) || catalog.complete !== true || catalog.documentUrl !== page.href ||
      !Array.isArray(catalog.urls) || catalog.urls.length > 4096 || catalog.urls.some((u) => typeof u !== "string")
    ) throw new Error("Codex loaded module catalog is unavailable in this window");
    sources = catalog.urls as string[];
  } else {
    sources = [...ownerWindow.document.querySelectorAll('link[rel="modulepreload"][href]')].map((l) => l.getAttribute("href") ?? "");
  }
  const urls = new Set<string>();
  for (const src of sources) {
    try {
      const u = new URL(src, page);
      if (u.protocol === page.protocol && u.host === page.host && u.pathname.endsWith(".js") && !u.search && !u.hash) urls.add(u.href);
    } catch { continue; }
  }
  const candidates = [...urls].sort((a, b) => Number(b.includes("/app-shared-")) - Number(a.includes("/app-shared-")));
  const matches = new Set<T>();
  const addMatch = (v: unknown): void => {
    if (matchesServices(v)) matches.add(v);
    if (matches.size > 1) throw new Error("Codex native services are unavailable in this window");
  };
  const runtimes = new Set<object>();
  for (const url of candidates) {
    let mod: Record<string, unknown>;
    try { mod = await importModule(url); } catch { continue; }
    Object.values(mod).forEach(addMatch);
    const req = mod.__webpack_require__;
    const cache = typeof req === "function" ? (Object.getOwnPropertyDescriptor(req, "c")?.value as unknown) : null;
    if (isObjectLike(cache)) runtimes.add(cache);
  }
  let scanned = 0;
  for (const runtime of runtimes) {
    const mods = Object.values(runtime);
    if (mods.length > 32_768) throw new Error("Codex native services are unavailable in this window");
    for (const [idx, mod] of mods.entries()) {
      if (idx > 0 && idx % 2_048 === 0) await new Promise((r) => setTimeout(r));
      const vals = compiledExportValues(mod);
      if ((scanned += vals.length) > 131_072) throw new Error("Codex native services are unavailable in this window");
      vals.forEach(addMatch);
    }
  }
  if (catalog !== undefined && Reflect.get(ownerWindow, "__codexhostLoadedModulesV1") !== catalog) {
    throw new Error("Codex loaded module catalog changed during discovery");
  }
  return [...matches][0] ?? null;
}

export function isNativeWorkspaceFilesServices(v: unknown): v is NativeWorkspaceFilesServices {
  if (!isRecord(v) || !Object.hasOwn(v, "workspaceFiles")) return false;
  const wf = v.workspaceFiles as NativeWorkspaceFiles | null | undefined;
  return isObjectLike(wf) && typeof wf.browseDirectory === "function";
}

export function resolvePreferredProjectParentDirectory(homeDir: string, setting: string, hostId?: string): string | null {
  const raw = setting.trim();
  if (!raw) return null;
  const home = homeDir.trim().replace(/\/+$/u, "");
  if (raw === "~") return home.startsWith("/") ? home : null;
  if (raw.startsWith("~/")) {
    const sub = raw.slice(2).replace(/^\/+|\/+$/gu, "");
    if (!home.startsWith("/") || !sub) return null;
    return home.endsWith(`/${sub}`) ? home : `${home}/${sub}`;
  }
  const isLocal = !hostId || hostId.trim() === "" || hostId.trim() === "local";
  if (!isLocal || !raw.startsWith("/")) return null;
  return raw === "/" ? "/" : raw.replace(/\/+$/u, "");
}

const isBrowseResponse = (v: unknown): v is BrowseDirectoryResponse =>
  isRecord(v) && typeof v.directoryPath === "string" && v.directoryPath.trim().length > 0;

export function wrapWorkspaceFilesWithDefaultDirectory(
  workspaceFiles: NativeWorkspaceFiles,
  defaultDirectory: string,
  onDefaultBrowse?: (hostKey: string) => void,
): NativeWorkspaceFiles {
  const target = (Reflect.get(workspaceFiles as object, WRAPPED_FILES_SYM) as NativeWorkspaceFiles | undefined) ?? workspaceFiles;
  const preferredByHost = new Map<string, string>();
  const callBrowse = (p: BrowseDirectoryRequest) =>
    Reflect.apply(target.browseDirectory, target, [p]) as NativeDisposablePromise<BrowseDirectoryResponse>;

  const browseDirectory = (params: BrowseDirectoryRequest): NativeDisposablePromise<BrowseDirectoryResponse> => {
    const dir = isRecord(params) ? params.directoryPath : undefined;
    const isEmpty = dir === null || dir === undefined || (typeof dir === "string" && dir.trim().length === 0);
    if (!isRecord(params) || !isEmpty || !defaultDirectory.trim()) return callBrowse(params);
    const hostKey = typeof params.hostId === "string" && params.hostId.trim() ? params.hostId.trim() : "local";
    onDefaultBrowse?.(hostKey);

    const active = new Set<() => void>();
    const invoke = async (reqParams: BrowseDirectoryRequest): Promise<BrowseDirectoryResponse> => {
      const req = callBrowse(reqParams);
      const disposeOne = getRequestDisposer(req);
      if (disposeOne) active.add(disposeOne);
      try { return await req; } finally { if (disposeOne) { active.delete(disposeOne); disposeOne(); } }
    };

    const promise = (async () => {
      const cached = preferredByHost.get(hostKey);
      if (cached) {
        try {
          const hit = await invoke({ ...params, directoryPath: cached });
          if (isBrowseResponse(hit)) return hit;
        } catch { preferredByHost.delete(hostKey); }
      }
      const homeListing = await invoke(params);
      if (!isBrowseResponse(homeListing)) return homeListing;
      const preferred = resolvePreferredProjectParentDirectory(homeListing.directoryPath, defaultDirectory, hostKey);
      if (!preferred || preferred === homeListing.directoryPath) return homeListing;
      try {
        const listing = await invoke({ ...params, directoryPath: preferred });
        if (isBrowseResponse(listing)) {
          preferredByHost.set(hostKey, listing.directoryPath);
          return listing;
        }
      } catch { /* fall back to home directory */ }
      return homeListing;
    })();

    return attachDisposable(promise, () => {
      for (const fn of [...active]) { active.delete(fn); fn(); }
    });
  };

  return new Proxy(target, {
    get(t, prop) {
      if (prop === WRAPPED_FILES_SYM) return t;
      return prop === "browseDirectory" ? browseDirectory : Reflect.get(t, prop, t);
    },
  });
}

export function normalizeProjectRootPaths(paths: readonly string[] | undefined): string[] {
  if (!Array.isArray(paths)) return [];
  const out: string[] = [];
  for (const entry of paths) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    const clean = trimmed === "/" ? "/" : trimmed.replace(/\/+$/u, "");
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

const rootsSignature = (paths: readonly string[]): string => normalizeProjectRootPaths(paths).join("\0");

async function readLocalProjectsMap(services: NativeWorkspaceFilesServices): Promise<Record<string, NativeLocalProjectEntry>> {
  try {
    const fromCatalog = await services.projectCatalog?.readLocalProjects?.();
    if (isRecord(fromCatalog)) return fromCatalog as Record<string, NativeLocalProjectEntry>;
  } catch { /* fall back */ }
  try {
    const fromState = await services.applicationState?.read?.("local-projects");
    if (isRecord(fromState) && isRecord(fromState.value)) return fromState.value as Record<string, NativeLocalProjectEntry>;
  } catch { /* ignore */ }
  return {};
}

export function refreshAccountScopedGlobalState(
  ownerWindow: Window,
  services?: NativeWorkspaceFilesServices | null,
  keys: readonly string[] = ACCOUNT_SCOPED_GLOBAL_STATE_KEYS,
): void {
  try {
    ownerWindow.postMessage({ type: "global-state-updated", keys: [...keys] }, "*");
    ownerWindow.postMessage({ type: "workspace-root-options-updated" }, "*");
  } catch { /* ignore in stubs */ }
  const invalidate = services?.queryCache?.invalidateQueryCache;
  if (invalidate) {
    void invalidate({ queryKey: ["vscode", "get-global-state"] }).catch(() => undefined);
    void invalidate({ queryKey: ["workspace-root-options"] }).catch(() => undefined);
  }
}

export async function reconcileDuplicateLocalProjects(
  services: NativeWorkspaceFilesServices,
  ownerWindow?: Window,
): Promise<boolean> {
  if (!services.projects?.removeLocal) return false;
  const groups = new Map<string, NativeLocalProjectEntry[]>();
  for (const [key, entry] of Object.entries(await readLocalProjectsMap(services))) {
    if (!isRecord(entry) || !Array.isArray(entry.rootPaths)) continue;
    const sig = rootsSignature(entry.rootPaths);
    if (!sig) continue;
    const id = typeof entry.id === "string" && entry.id.trim() ? entry.id : key;
    const list = groups.get(sig) ?? [];
    list.push({ ...entry, id });
    groups.set(sig, list);
  }

  let modified = false;
  for (const entries of groups.values()) {
    if (entries.length <= 1) continue;
    const [canonical, ...duplicates] = [...entries].sort(byCreatedAt);
    if (!canonical) continue;
    const dupIds = new Set(duplicates.map((d) => d.id));

    try {
      const memberships = await services.threadProjectAssignments?.readMemberships?.();
      for (const [threadId, a] of Object.entries(memberships?.assignments ?? {})) {
        if (a?.projectKind === "local" && typeof a.projectId === "string" && dupIds.has(a.projectId)) {
          await services.threadProjectAssignments?.setAssignment?.({
            threadId,
            assignment: { projectKind: "local", projectId: canonical.id },
          });
        }
      }
    } catch { /* ignore */ }

    let nextOrder: string[] | null = null;
    try {
      const cur = await services.projectPresentation?.readOrder?.();
      if (Array.isArray(cur) && cur.length > 0) {
        nextOrder = [];
        for (const id of cur) {
          if (typeof id !== "string") continue;
          const mapped = dupIds.has(id) ? canonical.id : id;
          if (!nextOrder.includes(mapped)) nextOrder.push(mapped);
        }
      }
    } catch { /* ignore */ }

    try {
      const sel = await services.projectCatalog?.readSelection?.();
      if (sel?.type === "local" && typeof sel.projectId === "string" && dupIds.has(sel.projectId)) {
        await services.applicationState?.write?.("selected-project", { type: "local", projectId: canonical.id });
      }
    } catch { /* ignore */ }

    for (const dup of duplicates) {
      await services.projects.removeLocal(dup.id);
      modified = true;
    }
    if (nextOrder && services.projects.setProjectOrder) {
      await services.projects.setProjectOrder(nextOrder).catch(() => undefined);
    }
  }

  if (modified && ownerWindow) refreshAccountScopedGlobalState(ownerWindow, services);
  return modified;
}

export function wrapProjectsWithDeduplication(
  projects: NativeProjectsService,
  services: NativeWorkspaceFilesServices,
  ownerWindow?: Window,
): NativeProjectsService {
  const target = (Reflect.get(projects as object, WRAPPED_PROJECTS_SYM) as NativeProjectsService | undefined) ?? projects;
  const callCreate = (p: CreateLocalProjectRequest) =>
    Reflect.apply(target.createLocal, target, [p]) as NativeDisposablePromise<CreateLocalProjectResponse | null>;

  const createLocal = (params: CreateLocalProjectRequest): NativeDisposablePromise<CreateLocalProjectResponse | null> => {
    const requestedSig = isRecord(params) && Array.isArray(params.sources) ? rootsSignature(params.sources) : "";
    if (!requestedSig) return callCreate(params);

    let disposeUnderlying: (() => void) | undefined;
    const promise = (async () => {
      const matching = Object.entries(await readLocalProjectsMap(services))
        .filter(([, e]) => isRecord(e) && Array.isArray(e.rootPaths) && rootsSignature(e.rootPaths) === requestedSig)
        .map(([k, e]) => ({ ...e, id: typeof e.id === "string" && e.id.trim() ? e.id : k }))
        .sort(byCreatedAt)[0];

      if (matching) {
        if (params.setActive !== false) {
          await services.applicationState?.write?.("selected-project", { type: "local", projectId: matching.id }).catch(() => undefined);
        }
        try {
          const cur = await services.projectPresentation?.readOrder?.();
          if (Array.isArray(cur) && services.projects?.setProjectOrder) {
            await services.projects.setProjectOrder([matching.id, ...cur.filter((id) => typeof id === "string" && id !== matching.id)]).catch(() => undefined);
          }
        } catch { /* ignore */ }
        if (ownerWindow) refreshAccountScopedGlobalState(ownerWindow, services);
        return { projectId: matching.id, rootPaths: matching.rootPaths };
      }

      const req = callCreate(params);
      disposeUnderlying = getRequestDisposer(req);
      try {
        const created = await req;
        await reconcileDuplicateLocalProjects(services, ownerWindow).catch(() => false);
        return created;
      } finally {
        disposeUnderlying?.();
        disposeUnderlying = undefined;
      }
    })();

    return attachDisposable(promise, () => {
      disposeUnderlying?.();
      disposeUnderlying = undefined;
    });
  };

  return new Proxy(target, {
    get(t, prop) {
      if (prop === WRAPPED_PROJECTS_SYM) return t;
      return prop === "createLocal" ? createLocal : Reflect.get(t, prop, t);
    },
  });
}

function shouldRefreshOnMessage(data: unknown): boolean {
  if (!isRecord(data) || typeof data.type !== "string") return false;
  if (REFRESH_MESSAGE_TYPES.has(data.type)) {
    return data.type !== "codex-app-server-connection-changed" || data.state === "connected";
  }
  return data.type === "codex-chunked-message" && data.kind === "end" && typeof data.channel === "string" && data.channel.includes("persisted-atom");
}

export function installProjectPickerPage(api: PluginApi, options: InstallProjectPickerPageOptions = {}): () => void {
  const ownerWindow = options.ownerWindow ?? window;
  const defaultDirectory = typeof api.settings.defaultDirectory === "string" ? api.settings.defaultDirectory.trim() : "";

  let disposed = false;
  let installing = false;
  let reconciling = false;
  let retryTicks = 0;
  let retryTimer: ReturnType<typeof setInterval> | null = null;
  let installed: NativeWorkspaceFilesServices | null = null;
  let origFiles: NativeWorkspaceFiles | null = null;
  let wrappedFiles: NativeWorkspaceFiles | null = null;
  let origProjects: NativeProjectsService | null = null;
  let wrappedProjects: NativeProjectsService | null = null;

  const stopRetry = () => { if (retryTimer !== null) { clearInterval(retryTimer); retryTimer = null; } };
  const applyDefaultDir = () => {
    if (disposed || !defaultDirectory) return;
    void api.request("applyDefaultDirectory").catch((err) => { if (!disposed) api.log("applyDefaultDirectory failed", err); });
  };
  const syncProjects = () => {
    if (disposed) return;
    refreshAccountScopedGlobalState(ownerWindow, installed);
    if (!installed || reconciling) return;
    reconciling = true;
    void reconcileDuplicateLocalProjects(installed, ownerWindow).catch(() => false).finally(() => { reconciling = false; });
  };

  const tryInstall = () => {
    if (disposed || installing || installed !== null) return;
    installing = true;
    void (async () => {
      try {
        const services = await loadCodexNativeServices(ownerWindow, isNativeWorkspaceFilesServices, options.importModule);
        if (disposed || !services || installed !== null) return;
        stopRetry();
        installed = services;
        if (defaultDirectory) {
          origFiles = (Reflect.get(services.workspaceFiles as object, WRAPPED_FILES_SYM) as NativeWorkspaceFiles | undefined) ?? services.workspaceFiles;
          wrappedFiles = wrapWorkspaceFilesWithDefaultDirectory(origFiles, defaultDirectory, (h) => { if (h === "local") applyDefaultDir(); });
          services.workspaceFiles = wrappedFiles;
        }
        if (isObjectLike(services.projects) && typeof services.projects.createLocal === "function") {
          origProjects = (Reflect.get(services.projects as object, WRAPPED_PROJECTS_SYM) as NativeProjectsService | undefined) ?? services.projects;
          wrappedProjects = wrapProjectsWithDeduplication(origProjects, services, ownerWindow);
          services.projects = wrappedProjects;
        }
        syncProjects();
      } catch { /* retry on next signal */ } finally { installing = false; }
    })();
  };

  const onMessage = (event: MessageEvent) => {
    if (disposed) return;
    const data = event.data as unknown;
    if (isRecord(data) && typeof data.type === "string" && OPEN_PANEL_RESET_MESSAGE_TYPES.has(data.type)) applyDefaultDir();
    if (shouldRefreshOnMessage(data)) { tryInstall(); syncProjects(); }
  };

  ownerWindow.addEventListener("message", onMessage);
  ownerWindow.addEventListener("codexhost:draft-prewarm-policy-changed", tryInstall);
  ownerWindow.addEventListener("codexhost:renderer-adapter-status", tryInstall);
  applyDefaultDir();
  tryInstall();

  const retryMs = options.retryIntervalMs ?? 1_000;
  if (retryMs > 0) {
    retryTimer = setInterval(() => {
      if (disposed || installed !== null || ++retryTicks > 15) return stopRetry();
      tryInstall();
    }, retryMs);
  }

  return () => {
    if (disposed) return;
    disposed = true;
    stopRetry();
    ownerWindow.removeEventListener("message", onMessage);
    ownerWindow.removeEventListener("codexhost:draft-prewarm-policy-changed", tryInstall);
    ownerWindow.removeEventListener("codexhost:renderer-adapter-status", tryInstall);
    if (installed && origFiles && installed.workspaceFiles === wrappedFiles) installed.workspaceFiles = origFiles;
    if (installed && origProjects && installed.projects === wrappedProjects) installed.projects = origProjects;
    installed = origFiles = wrappedFiles = origProjects = wrappedProjects = null;
  };
}

export default function activate(api: PluginApi): () => void {
  return installProjectPickerPage(api);
}
