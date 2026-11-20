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
npm ci
"$node" scripts/build.mjs

# Stop a previous daemon first so it cannot overwrite the config written below.
launchctl bootout "$domain/$label" 2>/dev/null || true
i=0
while launchctl print "$domain/$label" >/dev/null 2>&1; do
  i=$((i + 1))
  [ $i -le 50 ] || die "previous LaunchAgent did not stop"
  sleep 0.1
done

if [ -n "$picker_dir" ]; then
  CXP_PICKER_DIR="$picker_dir" "$node" --input-type=module -e '
    import { configPath, readConfig, writeConfig } from "./daemon/config.ts";
    const config = readConfig();
    const entry = (config.plugins["project-picker"] ??= {});
    entry.settings = { ...entry.settings, defaultDirectory: process.env.CXP_PICKER_DIR };
    writeConfig(config);
    console.log(`project-picker defaultDirectory -> ${process.env.CXP_PICKER_DIR} (${configPath()})`);
  '
fi

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
