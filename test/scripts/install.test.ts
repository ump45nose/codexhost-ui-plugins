import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(config?: string, cellar = false) {
  const root = mkdtempSync(resolve(".w40b-install-"));
  roots.push(root);
  const bin = cellar ? join(root, "Cellar/node/26.0/bin") : join(root, "bin");
  const configDir = join(root, ".config/codexhost-ui-plugins");
  const configPath = join(configDir, "config.json");
  const launchLog = join(root, "launchctl.log");
  const serviceState = join(root, "launchagent-running");
  writeFileSync(serviceState, "running");
  mkdirSync(bin, { recursive: true });
  const executable = (name: string, source: string) => {
    const path = join(bin, name);
    writeFileSync(path, source);
    chmodSync(path, 0o755);
  };
  const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  executable("node", `#!/bin/sh\n[ "$1" != scripts/build.mjs ] || exit 0\nexec ${node} "$@"\n`);
  executable("npm", "#!/bin/sh\nexit 0\n");
  executable("launchctl", `#!/bin/sh
printf '%s\\n' "$1" >> "$CXP_TEST_LAUNCH_LOG"
case "$1" in
  print) [ -f "$CXP_TEST_SERVICE_STATE" ];;
  bootout) rm -f "$CXP_TEST_SERVICE_STATE";;
  bootstrap) printf running > "$CXP_TEST_SERVICE_STATE";;
  *) exit 1;;
esac
`);
  if (config !== undefined) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, config, { mode: 0o600 });
  }
  const install = (...args: string[]) => execFileSync("/bin/sh", [resolve("scripts/install.sh"), ...args], {
    env: {
      ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, ".config"), PATH: `${bin}:${process.env.PATH}`,
      CXP_TEST_LAUNCH_LOG: launchLog, CXP_TEST_SERVICE_STATE: serviceState,
    },
    stdio: "pipe",
  });
  const launchCalls = () => existsSync(launchLog) ? readFileSync(launchLog, "utf8").trim().split("\n") : [];
  return { root, bin, configDir, configPath, install, launchCalls, serviceRunning: () => existsSync(serviceState) };
}

describe("Homebrew node path", () => {
  it("uses the stable prefix link for a Cellar node", () => {
    const f = fixture(undefined, true);
    const stable = join(f.root, "bin/node");
    mkdirSync(join(f.root, "bin"));
    writeFileSync(stable, readFileSync(join(f.bin, "node")), { mode: 0o755 });
    f.install();
    expect(readFileSync(join(f.root, "Library/LaunchAgents/io.github.ump45nose.codexhost-ui-plugins.plist"), "utf8")).toContain(`<string>${stable}</string>`);
  });

  it.each(["missing", "old"])("leaves the service running when the stable node is %s", (kind) => {
    const f = fixture(undefined, true);
    if (kind === "old") {
      mkdirSync(join(f.root, "bin"));
      writeFileSync(join(f.root, "bin/node"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }
    expect(() => f.install()).toThrow();
    expect(f.launchCalls()).toEqual([]);
    expect(f.serviceRunning()).toBe(true);
  });
});

describe("installation preserves configuration", () => {
  it("fills a missing picker directory in place and retains unrelated and unknown settings", () => {
    const config = { version: 1, custom: { keep: true }, plugins: { "project-picker": { enabled: false, settings: { another: 123 } }, pet: { enabled: false } } };
    const f = fixture(JSON.stringify(config));
    const before = statSync(f.configPath);
    f.install("--picker-dir", f.root);
    expect(JSON.parse(readFileSync(f.configPath, "utf8"))).toEqual({
      ...config, plugins: { ...config.plugins, "project-picker": { enabled: false, settings: { another: 123, defaultDirectory: f.root } } },
    });
    expect(statSync(f.configPath).ino).toBe(before.ino);
    expect(statSync(f.configPath).mode).toBe(before.mode);
    expect(readdirSync(f.configDir)).toEqual(["config.json"]);
    expect(f.launchCalls()).toEqual(["bootout", "print", "bootstrap"]);
    expect(f.serviceRunning()).toBe(true);
  });

  it("keeps an existing picker directory and the exact file contents on reinstall", () => {
    const original = '{ "plugins": { "project-picker": { "settings": { "defaultDirectory": "/existing" } } }, "keep": true }\n';
    const f = fixture(original);
    const before = statSync(f.configPath);
    f.install("--picker-dir", f.root);
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
    expect(statSync(f.configPath).ino).toBe(before.ino);
    expect(statSync(f.configPath).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(f.configDir)).toEqual(["config.json"]);
  });

  it("fills an empty picker directory in place while retaining its other settings", () => {
    const config = { plugins: { "project-picker": { enabled: false, settings: { defaultDirectory: "", keep: 123 } } } };
    const f = fixture(JSON.stringify(config));
    const before = statSync(f.configPath);
    f.install("--picker-dir", f.root);
    expect(JSON.parse(readFileSync(f.configPath, "utf8"))).toEqual({
      plugins: { "project-picker": { enabled: false, settings: { defaultDirectory: f.root, keep: 123 } } },
    });
    expect(statSync(f.configPath).ino).toBe(before.ino);
    expect(readdirSync(f.configDir)).toEqual(["config.json"]);
  });

  it("retains a complete existing configuration when no picker directory is supplied", () => {
    const original = '{"plugins":{"pet":{"enabled":false}},"custom":17}\n';
    const f = fixture(original);
    f.install();
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
    expect(readdirSync(f.configDir)).toEqual(["config.json"]);
  });

  it.each([true, false])("creates configuration only when absent (picker directory: %s)", (picker) => {
    const f = fixture();
    f.install(...(picker ? ["--picker-dir", f.root] : []));
    const config = JSON.parse(readFileSync(f.configPath, "utf8"));
    expect(config.plugins).toBeTypeOf("object");
    if (picker) expect(config.plugins["project-picker"].settings.defaultDirectory).toBe(f.root);
    expect(readdirSync(f.configDir)).toEqual(["config.json"]);
  });

  it("adds a missing plugins object without losing existing fields", () => {
    const f = fixture('{"custom":"preserved"}');
    const before = statSync(f.configPath);
    f.install();
    expect(JSON.parse(readFileSync(f.configPath, "utf8"))).toEqual({ custom: "preserved", plugins: {} });
    expect(statSync(f.configPath).ino).toBe(before.ino);
  });

  it.each([true, false])("retains the running service and original file when existing JSON is invalid (picker: %s)", (picker) => {
    const f = fixture("{invalid");
    const before = statSync(f.configPath);
    expect(() => f.install(...(picker ? ["--picker-dir", f.root] : []))).toThrow();
    expect(readFileSync(f.configPath, "utf8")).toBe("{invalid");
    expect(statSync(f.configPath).ino).toBe(before.ino);
    expect(readdirSync(f.configDir)).toEqual(["config.json"]);
    expect(f.launchCalls()).toEqual([]);
    expect(f.serviceRunning()).toBe(true);
  });
});
