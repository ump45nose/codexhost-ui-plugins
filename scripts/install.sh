#!/bin/sh
# Installs (or reinstalls) the daemon as a LaunchAgent running from this checkout.
# Usage: scripts/install.sh [--picker-dir <dir>]
set -eu

label=io.github.ump45nose.codexhost-ui-plugins
repo=$(cd "$(dirname "$0")/.." && pwd -P)
plist="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$HOME/Library/Logs/codexhost-ui-plugins"
domain="gui/$(id -u)"

die() {
  echo "install: $*" >&2
  exit 1
}

picker_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --picker-dir)
      [ $# -ge 2 ] || die "--picker-dir needs a directory"
      [ -d "$2" ] || die "--picker-dir: not a directory: $2"
      picker_dir=$(cd "$2" && pwd -P)
      shift 2
      ;;
    -h | --help)
      echo "usage: scripts/install.sh [--picker-dir <dir>]"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

node=$(command -v node) || die "Node.js >= 22.18 is required, but node is not on PATH"
"$node" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' ||
  die "Node.js >= 22.18 is required, found $("$node" -v) at $node"
command -v npm >/dev/null || die "npm is not on PATH"

cd "$repo"

# Installation fills missing fields in place, preserving the file and existing choices. The
# running daemon still uses its normal atomic writer for later setting changes.
configure() {
  CXP_PICKER_DIR="$picker_dir" CXP_CONFIG_WRITE="$1" "$node" --input-type=module -e '
  import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
  import { dirname } from "node:path";
  import { configPath, readConfig } from "./daemon/config.ts";
  const path = configPath();
  const exists = existsSync(path);
  const config = exists ? JSON.parse(readFileSync(path, "utf8")) : readConfig();
  let changed = !exists;
  if (config.plugins === undefined) {
    config.plugins = {};
    changed = true;
  }
  const directory = process.env.CXP_PICKER_DIR;
  const existingDirectory = config.plugins["project-picker"]?.settings?.defaultDirectory;
  if (directory && (existingDirectory === undefined || existingDirectory === "")) {
    const entry = (config.plugins["project-picker"] ??= {});
    (entry.settings ??= {}).defaultDirectory = directory;
    changed = true;
    if (process.env.CXP_CONFIG_WRITE === "1") console.log(`project-picker defaultDirectory -> ${directory} (${path})`);
  }
  if (changed && process.env.CXP_CONFIG_WRITE === "1") {
    if (!exists) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { flag: exists ? "w" : "wx" });
  }
'
}

# Parse and prepare the same config changes before rebuilding or stopping the installed service.
# Invalid existing JSON must leave the running LaunchAgent and its configuration untouched.
configure 0
npm ci
"$node" scripts/build.mjs

# Stop a previous daemon first so it cannot overwrite the config written below. Read it again
# after stopping, since the daemon could have saved newer settings during the build.
launchctl bootout "$domain/$label" 2>/dev/null || true
i=0
while launchctl print "$domain/$label" >/dev/null 2>&1; do
  i=$((i + 1))
  [ $i -le 50 ] || die "previous LaunchAgent did not stop"
  sleep 0.1
done
configure 1

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
mkdir -p "$log_dir" "$(dirname "$plist")"
cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$node")</string>
    <string>$(xml "$repo/daemon/main.ts")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$repo")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$(dirname "$node"):/usr/bin:/bin:/usr/sbin:/sbin")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>StandardOutPath</key><string>$(xml "$log_dir/daemon.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$log_dir/daemon.log")</string>
</dict>
</plist>
EOF

launchctl bootstrap "$domain" "$plist"
echo "Installed $label from $repo"
echo "Log: $log_dir/daemon.log"
