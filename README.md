# everywhere

Run terminals on any of your machines and use them from a browser. A small Go
daemon runs on each machine; a Cloudflare Worker handles login, the device
list and WebRTC signaling; terminal traffic goes browser ↔ daemon directly
over WebRTC (via Tailscale). See [SPEC.md](SPEC.md) for the design.

```
apps/worker/       Cloudflare Worker (Hono, D1, AccountHub Durable Object)
apps/web/          React SPA served by the Worker
packages/protocol/ wire protocol types (mirrored in daemon/internal/protocol)
daemon/            Go daemon + CLI (`everywhere`)
```

## Adding a device

In the web UI: **Add device**, then run the one-time command it shows on the
machine:

```sh
curl -fsSL https://ai.replogle.dev/i/<token> | sh
```

The installer downloads the latest release for the machine's architecture,
enrolls it, and installs a systemd service: a user service with lingering, or
a system service when run as root. The viewing device must be on the same
tailnet as the device.

On the device:

```sh
everywhere add ~/code/api     # register a project (also possible from the web UI)
everywhere status
everywhere update
everywhere uninstall [--purge]
```

## Development

Prerequisites: Bun, Go 1.27+, Wrangler logged in.

```sh
bun install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
bun run --filter @everywhere/worker migrate:local
bun run build                       # the Worker serves apps/web/dist
bun run dev                         # worker on :8787, vite on :5173 (proxies /api)
```

Run a local daemon against it without touching your real config or systemd:

```sh
cd daemon && CGO_ENABLED=0 go build -o bin/everywhere ./cmd/everywhere
# In the web UI (http://localhost:5173) sign up, click "Add device", copy the command, then:
EVERYWHERE_HOME=/tmp/ew EVERYWHERE_BIN_DIR=/tmp/ew/bin EVERYWHERE_NO_SERVICE=1 \
  EVERYWHERE_BINARY=$PWD/bin/everywhere sh -c '<paste command>'
EVERYWHERE_HOME=/tmp/ew /tmp/ew/bin/everywhere daemon -v
```

End-to-end test (hub signaling → WebRTC → RPC → PTY), against that stack:

```sh
cd daemon
EW_E2E_SERVER=http://localhost:8787 EW_E2E_COOKIE='ew_session=…' EW_E2E_DEVICE=<device id> \
  go test ./internal/e2e -v -count=1
```

## Releasing and deploying

- **Daemon:** push a `v*` tag. GitHub Actions runs goreleaser and publishes
  `everywhere_{linux,darwin}_{amd64,arm64}.tar.gz` plus `checksums.txt`. The
  installer and `everywhere update` depend on those names.
- **Worker:** `bun run deploy`. This builds the web app, applies D1 migrations
  remotely and deploys to `ai.replogle.dev`. Sign up immediately after the
  first deploy; the first signup becomes the only account.
