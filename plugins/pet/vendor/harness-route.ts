// Copyright (C) CodexHost contributors.
// SPDX-License-Identifier: LGPL-3.0-only
// Ported from codex-host packages/shared-contracts/src/harness-route.ts.

export const HARNESS_PLUGIN_ROUTE_PREFIX = "codexhost/plugin-v1@";
const HARNESS_PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export function isValidHarnessId(value: unknown): value is string {
  return typeof value === "string" && value !== "codex" && HARNESS_PLUGIN_ID_PATTERN.test(value);
}

/** Encodes a minimal `{ harnessId }` route into CodexHost's transport-safe ASCII format. */
export function encodeHarnessPluginRoute(route: { readonly harnessId: string }): string {
  if (!isValidHarnessId(route.harnessId)) {
    throw new Error(`Invalid Harness plugin id: ${String(route.harnessId)}`);
  }
  const payload = [...JSON.stringify({ harnessId: route.harnessId })]
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  return `${HARNESS_PLUGIN_ROUTE_PREFIX}${payload}`;
}
