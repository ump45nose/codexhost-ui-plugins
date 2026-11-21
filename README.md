# codexhost-ui-plugins

UI plugins for Codex Desktop (`/Applications/ChatGPT.app`) when it is started by codexhost with a
remote debugging port. A small Node daemon, run by launchd, finds Desktop, injects a page loader
and the plugins into its windows, and runs each plugin's local tasks. Desktop's installation is
never modified.

## Requirements

- macOS, with Codex Desktop launched by codexhost (debugging port open)
- Node.js 22.18 or newer, and `npm`, on `PATH`
- git

## Install

```sh
git clone https://github.com/ump45nose/codexhost-ui-plugins.git
cd codexhost-ui-plugins
scripts/install.sh [--picker-dir <dir>]
```

The script runs `npm ci`, builds `dist/`, and installs a LaunchAgent that starts the daemon at
login and restarts it if it exits. `--picker-dir` sets the default directory of Desktop's project
picker. Running it again reinstalls.

## Uninstall

```sh
scripts/uninstall.sh
```

This stops the daemon and removes the LaunchAgent. Config and logs are kept.

## Files

- Config: `~/.config/codexhost-ui-plugins/config.json` (plugin on/off and settings, written by the daemon)
- Log: `~/Library/Logs/codexhost-ui-plugins/daemon.log`
- LaunchAgent: `~/Library/LaunchAgents/io.github.ump45nose.codexhost-ui-plugins.plist`

## Updates

Every 2 minutes the daemon runs `git fetch` in the checkout. When `main` is checked out, the
working tree is clean and the upstream can be fast-forwarded, it merges, runs `npm ci` if
`package-lock.json` changed, and builds a new `dist/`. The daemon then restarts on the new build,
and Desktop's pages reload the next time Desktop's main window is not in front.

If `npm ci` or the build fails, the checkout is reset to the previous commit, the old `dist/`
stays in use, and the plugin panel shows the error. That commit is not retried; a newer upstream
commit is. On another branch or with local changes nothing is pulled, and a manual `npm run build`
applies the local code the same way.

## How it fits together

- `daemon/` (Node, run as TypeScript) attaches to Desktop's browser endpoint with auto-attach,
  registers the loader plus every plugin for that window to run on each new document, and
  releases each paused target even if a setup step fails or times out.
- `loader/` starts and stops plugins inside the page, isolates each one, and shows the plugin
  panel (puzzle icon on the left rail) and failure notices. A failing plugin is switched off
  alone; the others keep running.
- `plugins/<id>/plugin.ts` declares the windows, settings, fork guards, Pet chunk rewrites
  (`identify`/`apply`, applied by the daemon through Fetch interception) and local tasks.
  Daemon-side plugin code must use erasable TypeScript syntax only.
- `shared/` holds page helpers; each plugin bundle gets its own copy, so plugins never depend on
  each other at runtime. The stash exposes `window.__cxpStashV1` for the top-tab stash entry.
- Plugin status is tracked per source (each page, the rewriter, the local task); any failure wins.
- While a codexhost fork still ships the same feature (its globals or DOM markers, or its own Pet
  chunk patches), the plugin stays dormant.
- Only public codexhost page globals, Host methods and Desktop's page structure are used. The Pet
  plugin also reads Desktop's `~/.codex/.codex-global-state.json` (read only) for remote projects.

## Known issues

- Around page reloads the log can show bursts of `Invalid InterceptionId` from the Pet rewriter;
  Pet still loads.
- A failed update commit is remembered in memory only, so it is retried once after a daemon restart.
- Local tasks import `errorText` from `daemon/channel.ts`.

## Development

```sh
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run build       # dist/
```

## License

LGPL-3.0-only
