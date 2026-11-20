#!/bin/sh
# Stops the daemon and removes its LaunchAgent. Local config and logs are kept.
set -eu

label=io.github.ump45nose.codexhost-ui-plugins
plist="$HOME/Library/LaunchAgents/$label.plist"

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
rm -f "$plist"
echo "Uninstalled $label"
echo "Kept: ~/.config/codexhost-ui-plugins/ and ~/Library/Logs/codexhost-ui-plugins/"
