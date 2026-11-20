import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath, readConfig } from "../../daemon/config.ts";
import { loadRegistry } from "../../daemon/registry.ts";

describe("registry", () => {
  it("merges dist manifest, plugin manifests and local config", async () => {
    const root = mkdtempSync(join(tmpdir(), "cxp-reg-"));
    process.env.HOME = join(root, "home");
    const dist = join(root, "dist");
    const pluginsDir = join(root, "plugins");
    mkdirSync(dist);
    const settings = [
      { key: "dir", type: "text", label: "Dir", default: "" },
      { key: "skip", type: "exclude-list", label: "Skip", options: ["a", "b"] },
    ];
    writeFileSync(join(dist, "build-id"), "abc1234\n");
    writeFileSync(join(dist, "loader.js"), "/* loader */");
    writeFileSync(
      join(dist, "manifest.json"),
      JSON.stringify({
        buildId: "abc1234",
        loader: "loader.js",
        plugins: [
          { id: "one", name: "One", windows: ["main"], file: "one.js", forkGuards: [], settings },
          { id: "two", name: "Two", windows: [], file: null, forkGuards: [], settings: [] },
        ],
      }),
    );
    for (const id of ["one", "two"]) {
      mkdirSync(join(pluginsDir, id), { recursive: true });
      writeFileSync(
        join(pluginsDir, id, "plugin.ts"),
        id === "one"
          ? `export default { id: "one", name: "One", windows: ["main"], rewrites: [{ name: "r", identify: () => false, apply: () => null }] };`
          : `export default { id: "two", name: "Two", windows: [], task: () => () => {} };`,
      );
    }
    mkdirSync(join(root, "home/.config/codexhost-ui-plugins"), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ plugins: { one: { settings: { dir: "/x" } }, two: { enabled: false } } }));

    const registry = await loadRegistry(dist, pluginsDir);
    expect(registry.buildId).toBe("abc1234");
    expect(registry.get("one")).toMatchObject({ enabled: true, settings: { dir: "/x", skip: [] }, file: "one.js" });
    expect(registry.get("one")?.rewrites).toHaveLength(1);
    expect(registry.get("two")).toMatchObject({ enabled: false, settings: {}, file: null });
    expect(typeof registry.get("two")?.task).toBe("function");

    registry.setEnabled("two", true);
    expect(readConfig().plugins.two).toEqual({ enabled: true, settings: {} });
    expect(readdirSync(join(root, "home/.config/codexhost-ui-plugins"))).toEqual(["config.json"]); // no temp file left
  });
});
