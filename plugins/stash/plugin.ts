import type { PluginManifest } from "../types.ts";

const manifest: PluginManifest = {
  id: "stash",
  name: "收纳箱",
  windows: ["main"],
  page: "./page.ts",
  forkGuards: ["__codexhostSidebarStashV1"],
};

export default manifest;
