import type { PluginManifest } from "../types.ts";
import { HARNESS_NAMES, startInstructionSync } from "./sync.ts";

const manifest: PluginManifest = {
  id: "harness-instructions",
  name: "统一指令",
  windows: [],
  task: startInstructionSync,
  settings: [{ key: "exclude", type: "exclude-list", label: "不同步的 Harness", options: HARNESS_NAMES, default: [] }],
};

export default manifest;
