import type { PluginManifest } from "../types.ts";

const manifest: PluginManifest = {
  id: "vertical",
  name: "竖屏",
  windows: ["main"],
  page: "./page.ts",
  // Fork's renderer-top-tabs mounts DOM markers with codexhost-specific names without setting a
  // dedicated window global. Guard on those DOM markers (the plugin itself uses cxp-* markers).
  forkGuards: ["dom:[data-codexhost-top-tabs]", "dom:#codexhost-top-tabs-styles"],
  settings: [
    {
      key: "sidebarAutoCollapse",
      type: "toggle",
      label: "窄屏自动收起左边栏",
      default: true,
    },
    {
      key: "sidebarOverlayBreakpoint",
      type: "number",
      label: "窄屏收起阈值 (px)",
      default: 1080,
      min: 600,
      max: 2560,
      step: 20,
    },
    {
      key: "topTabsEnabled",
      type: "toggle",
      label: "顶部活动会话条",
      default: true,
    },
    {
      key: "topTabsTwoRows",
      type: "toggle",
      label: "会话标签双排显示",
      default: true,
    },
  ],
};

export default manifest;
