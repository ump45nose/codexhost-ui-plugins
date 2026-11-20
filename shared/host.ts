// Calls into codexhost's Host through its public page global.

interface HostRouting {
  forHost(host: string): { manager: { sendRequest(method: string, params?: unknown): Promise<unknown> } };
}

export function hostRouting(): HostRouting | null {
  return ((globalThis as Record<string, unknown>).__codexhostHostRoutingV1 as HostRouting | undefined) ?? null;
}

/** Sends a native Codex or codexhost method to the given host (local or remote). */
export async function hostRequest(host: string, method: string, params?: unknown): Promise<unknown> {
  const routing = hostRouting();
  if (!routing) throw new Error("codexhost Host routing (__codexhostHostRoutingV1) is not available");
  return routing.forHost(host).manager.sendRequest(method, params);
}
