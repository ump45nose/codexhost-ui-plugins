// Copyright (C) CodexHost contributors.
// SPDX-License-Identifier: LGPL-3.0-only
// Ported from codex-host packages/renderer-extension/src/renderer-sidebar-agent-icons.ts.

export const SIDEBAR_THREAD_ROW_ATTRIBUTE = "data-app-action-sidebar-thread-row";
export const SIDEBAR_THREAD_ROW_SELECTOR = `[${SIDEBAR_THREAD_ROW_ATTRIBUTE}]`;
export const SIDEBAR_THREAD_ID_ATTRIBUTE = "data-app-action-sidebar-thread-id";
export const SIDEBAR_THREAD_HOST_ID_ATTRIBUTE = "data-app-action-sidebar-thread-host-id";
export const SIDEBAR_AGENT_ICON_ATTRIBUTE = "data-codexhost-sidebar-agent-icon";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a non-empty host thread id (mirrors hostThreadIdSchema). */
export function parseHostThreadId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return null;
  return trimmed;
}

export function sidebarThreadAttributes(element: HTMLElement): {
  taskKey: string;
  hostId: string;
  rowMarker: string;
} | null {
  const taskKey = element.getAttribute(SIDEBAR_THREAD_ID_ATTRIBUTE);
  const hostId = element.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE);
  const rowMarker = element.getAttribute(SIDEBAR_THREAD_ROW_ATTRIBUTE);
  if (taskKey === null || hostId === null || rowMarker === null) return null;
  return { taskKey, hostId, rowMarker };
}

export function threadIdFromSidebarRowElement(element: HTMLElement): string | null {
  const attributes = sidebarThreadAttributes(element);
  if (!attributes) return null;
  const { taskKey, hostId, rowMarker } = attributes;

  const fiberNames = Object.getOwnPropertyNames(element).filter((name) =>
    name.startsWith("__reactFiber$"),
  );
  const fiberName = fiberNames[0];
  if (fiberNames.length !== 1 || !fiberName) return null;
  const firstFiber = Object.getOwnPropertyDescriptor(element, fiberName)?.value;
  if (!isRecord(firstFiber)) return null;

  const candidates = new Set<string>();
  let fiber: Record<string, unknown> | null = firstFiber;
  for (let depth = 0; fiber && depth < 12; depth += 1) {
    const props = fiber.memoizedProps;
    if (isRecord(props) && isRecord(props.dataAttributes)) {
      const dataAttributes = props.dataAttributes;
      const threadId = parseHostThreadId(props.conversationId);
      if (
        threadId &&
        dataAttributes[SIDEBAR_THREAD_ROW_ATTRIBUTE] === rowMarker &&
        dataAttributes[SIDEBAR_THREAD_ID_ATTRIBUTE] === taskKey &&
        dataAttributes[SIDEBAR_THREAD_HOST_ID_ATTRIBUTE] === hostId
      ) {
        candidates.add(threadId);
      }
    }
    fiber = isRecord(fiber.return) ? fiber.return : null;
  }
  return candidates.size === 1 ? (candidates.values().next().value ?? null) : null;
}
