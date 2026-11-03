# Plugins

Plugins for everywhere that don't come with the daemon. Each folder here is
one plugin, published to the registry that devices install from:

- **In the app**: Settings → Plugins → Browse. Search, then install a plugin
  on one device or on every device that can take it. The app shows what the
  plugin asks for (its permissions and Claude tools) first.
- **On a device**: `everywhere plugin available`, `everywhere plugin install linear`,
  `everywhere plugin update`.

| Plugin | What it does |
|---|---|
| [linear](linear) | A Linear tab with a linked project's issues, issue pages, comments and status, and tools for Claude |

## How the registry works

`.github/workflows/plugins.yml` runs on every push to `main` that touches a
plugin. It runs `daemon/cmd/plugin-registry`, which checks each plugin's
`plugin.json` and web part the way the daemon does, builds its program for
Linux, macOS and Windows (amd64 and arm64), and packs an archive per platform.
The archives and `index.json` are published as assets of the rolling
`plugins` release (a prerelease, so daemon self-updates ignore it).

A device installs a plugin by downloading the archive for its platform. It
checks the archive against the sha256 in `index.json`, and checks that the
archive's `plugin.json` matches the one it showed you. The plugin goes in
`<data>/plugins/<id>/`, alongside a `.registry.json` that records where it
came from, so `update` knows which plugins it can update.

**A published version never changes.** If a plugin's version is already in
the registry, it isn't rebuilt. If its `plugin.json` changed without a version
bump, the build fails. To ship a change, bump `version`.

Point a device at another registry with `EVERYWHERE_PLUGIN_REGISTRY=<url of index.json>`
(for testing: `go run ./cmd/plugin-registry -out /tmp/reg`, serve `/tmp/reg`,
and point at its `index.json`).

## Adding a plugin

1. Make `plugins/<id>/` with a `plugin.json` (see PLUGINS.md and
   `daemon/sdk/plugin/example/notes`). Go plugins use the SDK in
   `daemon/sdk/plugin`; this folder is one Go module, so a plugin is a
   `package main` in its folder. Use `"command": ["./<id>"]`; the registry
   build names the program that, with `.exe` on Windows.
2. Try it on your machine: `go build -o <id> . && everywhere plugin install .`
3. Check it as CI will: `cd daemon && go run ./cmd/plugin-registry -plugins ../plugins -check`
4. Merge to `main`, and it's in the registry.

A plugin without Go sources (a script, or only `contributes.agents`) is
published as one archive for every platform.

Installing from the app is refused for plugins that ask for permissions that
need local consent (`screen`): those are installed on the device itself.
