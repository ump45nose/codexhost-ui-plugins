#!/usr/bin/env node
// Bundles the page loader and every plugin page entry into IIFEs and writes dist/manifest.json
// and dist/build-id.  Usage: node scripts/build.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist");
const target = "chrome120";

function git(...gitArgs) {
  return execFileSync("git", gitArgs, { cwd: root, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
}

/** Git short SHA, plus a hash of the uncommitted changes when the working tree is dirty. */
function computeBuildId() {
  const sha = git("rev-parse", "--short", "HEAD").toString().trim();
  if (git("status", "--porcelain").toString().trim() === "") return sha;
  const hash = createHash("sha256").update(git("diff", "HEAD", "--binary"));
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean);
  for (const file of untracked.sort()) {
    hash.update(`\0${file}\0`);
    hash.update(fs.readFileSync(path.join(root, file)));
  }
  return `${sha}-${hash.digest("hex").slice(0, 8)}`;
}

async function loadManifests() {
  const dir = path.join(root, "plugins");
  const ids = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "plugin.ts")))
    .map((e) => e.name)
    .sort();
  const manifests = [];
  for (const id of ids) {
    const mod = await import(pathToFileURL(path.join(dir, id, "plugin.ts")).href);
    const manifest = mod.default;
    if (manifest?.id !== id) throw new Error(`plugins/${id}/plugin.ts must export default a manifest with id "${id}"`);
    manifests.push(manifest);
  }
  return manifests;
}

async function bundle(contents, resolveDir, outfile) {
  await esbuild.build({
    stdin: { contents, resolveDir, sourcefile: path.basename(outfile, ".js") + "-entry.js", loader: "js" },
    bundle: true,
    format: "iife",
    platform: "browser",
    target,
    outfile,
    logLevel: "warning",
  });
}

const buildId = computeBuildId();
const manifests = await loadManifests();
const tmp = path.join(root, `.dist-build-${process.pid}`);
fs.rmSync(tmp, { recursive: true, force: true });

try {
  await bundle(
    `import { startLoader } from "./loader/core.ts";\nstartLoader(globalThis, ${JSON.stringify(buildId)});\n`,
    root,
    path.join(tmp, "loader.js"),
  );
  const plugins = [];
  for (const m of manifests) {
    let file = null;
    if (m.page) {
      file = `plugins/${m.id}.js`;
      const meta = { forkGuards: m.forkGuards ?? [] };
      await bundle(
        `import activate from ${JSON.stringify(m.page)};\n` +
          `globalThis.__cxpLoaderRegister(${JSON.stringify(m.id)}, activate, ${JSON.stringify(meta)});\n`,
        path.join(root, "plugins", m.id),
        path.join(tmp, file),
      );
    }
    plugins.push({
      id: m.id,
      name: m.name,
      windows: m.windows,
      file,
      forkGuards: m.forkGuards ?? [],
      settings: m.settings ?? [],
    });
  }
  fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify({ buildId, loader: "loader.js", plugins }, null, 2) + "\n");
  fs.writeFileSync(path.join(tmp, "build-id"), buildId);

  // Swap the finished build in so readers never see a half-written directory.
  const old = path.join(root, `.dist-old-${process.pid}`);
  const hadOut = fs.existsSync(out);
  if (hadOut) fs.renameSync(out, old);
  fs.renameSync(tmp, out);
  if (hadOut) fs.rmSync(old, { recursive: true, force: true });
} catch (error) {
  fs.rmSync(tmp, { recursive: true, force: true });
  throw error;
}

console.log(`built ${buildId}: loader + ${manifests.filter((m) => m.page).length} page plugin(s) -> dist`);
