import type { PluginManifest } from "../types.ts";
import { pickerTask } from "./task.ts";

const manifest: PluginManifest = {
  id: "project-picker",
  name: "项目选择器",
  windows: ["main"],
  task: pickerTask(),
  settings: [{ key: "defaultDirectory", type: "text", label: "选择框默认目录", default: "" }],
};

export default manifest;
