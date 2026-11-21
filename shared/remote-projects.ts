// Shared utilities for reading Codex Desktop's sidebar remote projects, globe colors, and host labels.
// Ported from codex-host renderer-sidebar-remote-projects.ts and react-fiber-props.ts (LGPL-3.0-only).

/** Codex colors each remote host's globe through this variable on the sidebar project icon. */
const GLOBE_COLOR_VARIABLE = "--remote-host-globe-color";
const REMOTE_PROJECT_SELECTOR = '[data-sidebar-project-kind="remote"]';
/** The globe from Codex's remote project icon, cropped to its own bounds. */
const GLOBE_VIEW_BOX = "8.03 8.79 6.6 6.6";
const GLOBE_PATH =
  "M11.3341 8.99774C13.0412 8.99817 14.4259 10.3823 14.4259 12.0895C14.4257 13.7967 13.0403 15.1802 11.3331 15.1804C9.62649 15.1796 8.24255 13.7963 8.24231 12.0895C8.24231 10.3821 9.62663 8.99774 11.3341 8.99774ZM10.88 12.53C10.9107 13.0499 10.9942 13.5041 11.1066 13.8405C11.1789 14.0567 11.2559 14.2013 11.3204 14.2829C11.3244 14.2878 11.3296 14.2914 11.3331 14.2956C11.3368 14.2913 11.3427 14.2881 11.3468 14.2829C11.4113 14.2012 11.4884 14.0568 11.5607 13.8405C11.6731 13.5041 11.7556 13.0499 11.7863 12.53H10.88ZM9.13489 12.53C9.2686 13.2 9.70172 13.7611 10.2882 14.071C10.1507 13.6447 10.0609 13.1116 10.0304 12.53H9.13489ZM12.6368 12.53C12.6061 13.1117 12.5146 13.6446 12.3771 14.071C12.964 13.7613 13.3976 13.2005 13.5314 12.53H12.6368ZM10.2882 10.1061C9.69233 10.421 9.25628 10.9962 9.13 11.6804H10.0284C10.0573 11.0859 10.1481 10.5404 10.2882 10.1061ZM11.3204 9.8952C11.2559 9.97691 11.1789 10.1221 11.1066 10.3386C10.9919 10.6818 10.9081 11.1473 10.879 11.6804H11.7872C11.7581 11.1474 11.6753 10.6818 11.5607 10.3386C11.4884 10.1223 11.4113 9.97695 11.3468 9.8952C11.3425 9.88982 11.3369 9.88594 11.3331 9.88153C11.3294 9.88589 11.3246 9.88996 11.3204 9.8952ZM12.3771 10.1052C12.5175 10.5396 12.6087 11.0853 12.6378 11.6804H13.5363C13.4099 10.9956 12.9736 10.4198 12.3771 10.1052Z";

export interface SidebarRemoteProject {
  readonly hostId: string;
  readonly hostDisplayName: string;
  readonly projectId: string;
  readonly label: string;
  readonly path: string;
}

const KNOWN_HOST_CASING: Readonly<Record<string, string>> = {
  macpro: "MacPro",
  macbookpro: "MacBookPro",
  macair: "MacAir",
  macbookair: "MacBookAir",
  macmini: "MacMini",
  macstudio: "MacStudio",
  nas: "NAS",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Walks up React's fiber chain from a native element and returns the first value `pick` derives
 * from a component's props. Used where Codex keeps data in props but not in the DOM.
 */
export function findReactProps<T>(
  element: Element,
  pick: (props: Record<string, unknown>) => T | null | undefined,
  maxDepth = 16,
): T | null {
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactFiber$"));
  let fiber: unknown = key ? (element as unknown as Record<string, unknown>)[key] : null;
  for (let depth = 0; isRecord(fiber) && depth < maxDepth; depth += 1) {
    const props = fiber.memoizedProps;
    if (isRecord(props)) {
      const picked = pick(props);
      if (picked !== null && picked !== undefined) return picked;
    }
    fiber = fiber.return;
  }
  return null;
}

/** Remote projects in sidebar order, read from each project row's native `group` prop. */
export function collectSidebarRemoteProjects(doc: Document): SidebarRemoteProject[] {
  const projects = new Map<string, SidebarRemoteProject>();
  for (const row of doc.querySelectorAll(
    `${REMOTE_PROJECT_SELECTOR} [data-app-action-sidebar-project-row]`,
  )) {
    const group = findReactProps(row, (props) => (isRecord(props.group) ? props.group : null));
    if (
      !group ||
      group.projectKind !== "remote" ||
      typeof group.hostId !== "string" ||
      typeof group.projectId !== "string" ||
      typeof group.path !== "string" ||
      !group.path
    )
      continue;
    const key = `${group.hostId}\n${group.projectId}`;
    if (projects.has(key)) continue;
    projects.set(key, {
      hostId: group.hostId,
      hostDisplayName: typeof group.hostDisplayName === "string" ? group.hostDisplayName : "",
      projectId: group.projectId,
      label: typeof group.label === "string" && group.label ? group.label : group.path,
      path: group.path,
    });
  }
  return [...projects.values()];
}

function readGlobeColorProperty(svg: SVGElement): string {
  const style = svg.style as CSSStyleDeclaration & Record<string, unknown>;
  if (typeof style?.getPropertyValue === "function") {
    const value = style.getPropertyValue(GLOBE_COLOR_VARIABLE).trim();
    if (value) return value;
  }
  const direct = style?.[GLOBE_COLOR_VARIABLE];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const attr = svg.getAttribute("style") ?? "";
  const match = /--remote-host-globe-color\s*:\s*([^;]+)/.exec(attr);
  return match?.[1]?.trim() ?? "";
}

/** Remote host -> globe color, read from the sidebar's remote project icons. */
export function readRemoteHostGlobeColors(doc: Document): Map<string, string> {
  const colors = new Map<string, string>();
  for (const svg of doc.querySelectorAll<SVGElement>(
    `${REMOTE_PROJECT_SELECTOR} svg[style*="${GLOBE_COLOR_VARIABLE}"]`,
  )) {
    const color = readGlobeColorProperty(svg);
    const hostId = findReactProps(svg, (props) =>
      typeof props.hostId === "string" ? props.hostId : null,
    );
    if (color && hostId && !colors.has(hostId)) colors.set(hostId, color);
  }
  return colors;
}

/** Codex's remote host globe in the host's color, or the current text color when unknown. */
export function createRemoteHostGlobe(
  doc: Document,
  color: string | null,
  className: string,
): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", GLOBE_VIEW_BOX);
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS(ns, "path");
  path.setAttribute("fill-rule", "evenodd");
  path.setAttribute("clip-rule", "evenodd");
  path.setAttribute("d", GLOBE_PATH);
  path.setAttribute("fill", color ?? "currentColor");
  svg.appendChild(path);
  return svg;
}

/** Normalizes a remote host id or custom display name to a concise label; returns null for local. */
export function resolveShortHostLabel(hostId: string, customLabel?: string | null): string | null {
  const id = hostId.trim();
  const raw = (customLabel?.trim() || id)
    .replace(/^remote-ssh-[a-z-]+:/i, "")
    .replace(/^ssh:\/\//i, "")
    .replace(/^[^@]+@/, "");
  if (!id || id === "local" || !raw || raw === "local") return null;
  const ipv4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(raw);
  if (ipv4?.[1]) return ipv4[1];
  const base = (raw.replace(/:\d+$/, "").split(".")[0] ?? raw).trim() || id;
  return KNOWN_HOST_CASING[base.toLowerCase()] ?? base.slice(0, 16);
}
