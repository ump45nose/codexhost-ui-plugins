import type { PluginApi } from "../types.ts";
import { installSidebarStash } from "./install.ts";

export default function activate(api: PluginApi): () => void {
  const handle = installSidebarStash({
    logger: {
      info: (...args) => api.log(...args),
      warn: (...args) => api.log("[warn]", ...args),
      debug: () => {},
    },
  });
  return () => {
    handle?.dispose();
  };
}
