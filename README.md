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

## Remote desktop (Omarchy / Hyprland)

See and control a machine's logged-in desktop from the web app, with low
latency over WebRTC. Turn it on at the machine itself:

```sh
everywhere desktop enable
```

Then use the monitor button on the device's row in the sidebar for the whole
desktop (workspaces, monitors), or add a **Desktop** tab to a thread to keep
one monitor or one window next to it. Fullscreen also sends Super, Alt+Tab and
Esc to the desktop (Chromium), and the clipboard is shared (text). It needs
Hyprland ≥ 0.56, a VA-API GPU, GStreamer's `va` plugins (`gst-plugins-bad`,
`gst-plugin-va`) and `wl-clipboard`; the `everywhere-desktop` worker comes in
the Linux release next to `everywhere`. macOS is planned (see TODO.md).

## Connecting ChatGPT (or another agent)

The Worker serves an MCP server at `https://ai.replogle.dev/mcp`. An agent that
connects to it can see every device's projects and threads, read them, create
projects and threads, message claude threads and answer their permission
prompts, and type into terminals. It can also work on code directly, like a
coding agent: `run_command` runs a shell command (with your login environment)
and returns its exit code and output, and `read_file`, `write_file`,
`edit_file`, `glob` and `grep` work with files, rooted in a thread's or
project's directory. These run as your user on the device, so only connect
agents you trust with a shell. In ChatGPT, turn on developer mode
(Settings → Apps & Connectors → Advanced), create a connector with that URL
and OAuth authentication, then sign in and approve it. Connected apps are
listed under Settings → Security, where you can disconnect them. Devices need
a daemon that includes this feature (`everywhere update`).

## Security

- **Accounts:** passwords are hashed with PBKDF2-SHA256 (100k iterations) and must be 10–256
  characters. Optional TOTP two-factor auth uses any authenticator app, with 10 single-use
  recovery codes. TOTP seeds are AES-GCM encrypted with the `TOTP_KEY` Worker secret.
- **Sessions:** `__Host-` cookie (HttpOnly, Secure, SameSite=Lax), valid for 30 days. You can list
  and revoke them under Settings → Security. Changing the password signs out every other session.
  Revoking a session closes its WebSocket, and daemons drop any WebRTC connections it opened.
- **Brute force:** login, 2FA, signup, enrollment and install links are rate-limited per IP.
  Login is also limited per username. A 2FA challenge dies after 5 wrong codes, and a TOTP code
  can't be used twice.
- **CSRF and hijacking:** state-changing API calls must be JSON from an allowed Origin, and the
  browser WebSocket checks Origin. Static pages have a strict CSP (`script-src 'self'`,
  `frame-ancestors 'none'`), HSTS, nosniff and no-referrer.
- **Connected apps (MCP):** OAuth 2.1 with PKCE, behind your normal sign-in plus a consent page.
  Access tokens last an hour and refresh tokens rotate. Tokens are stored hashed. Tool calls and
  their results pass through the Worker, unlike browser traffic.
- **Devices:** each daemon has its own bearer credential, stored hashed on the server and `0600`
  on the device. Removing a device revokes it immediately. Terminal data goes browser ↔ daemon
  over DTLS and never passes through the Worker.

**Locked out?** There's no email reset. From a machine logged in to the Cloudflare account:

```sh
bun run reset-password <username>                 # prints a temporary password, signs out all sessions
bun run reset-password <username> --disable-2fa   # also removes the authenticator + recovery codes
```

Don't rotate `TOTP_KEY` while 2FA is enabled; the stored seeds would become unreadable
(recover with `--disable-2fa`).

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
go build -o bin/everywhere-desktop ./cmd/everywhere-desktop   # remote desktop worker (cgo)
# In the web UI (http://localhost:5173) sign up, click "Add device", copy the command, then:
EVERYWHERE_HOME=/tmp/ew EVERYWHERE_BIN_DIR=/tmp/ew/bin EVERYWHERE_NO_SERVICE=1 \
  EVERYWHERE_BINARY=$PWD/bin/everywhere sh -c '<paste command>'
EVERYWHERE_HOME=/tmp/ew /tmp/ew/bin/everywhere daemon -v
```

API security test (auth, 2FA, CSRF, sessions, rate limits) against a fresh local Worker:

```sh
cd apps/worker && EW_TEST_SERVER=http://localhost:8787 bun test/security.e2e.ts
```

Remote desktop capture against the running Hyprland session (worker built as above):

```sh
cd daemon && EW_DESKTOP_LIVE=1 EVERYWHERE_DESKTOP_HELPER=$PWD/bin/everywhere-desktop \
  go test ./internal/desktop -run Live -v
```

End-to-end test (hub signaling → WebRTC → RPC → PTY), against that stack:

```sh
cd daemon
EW_E2E_SERVER=http://localhost:8787 EW_E2E_COOKIE='__Host-ew_session=…' EW_E2E_DEVICE=<device id> \
  go test ./internal/e2e -v -count=1
```

## Releasing and deploying

- **Daemon:** push a `v*` tag. GitHub Actions runs goreleaser and publishes
  `everywhere_{linux,darwin}_{amd64,arm64}.tar.gz` plus `checksums.txt`. The
  installer and `everywhere update` depend on those names.
- **Worker:** one-time setup, in `apps/worker`:
  `openssl rand -base64 32 | tr -d '\n' | bunx wrangler secret put TOTP_KEY` and
  `bun run vapid-key | bunx wrangler secret put VAPID_KEY` (signs push notifications; changing it
  later means every browser turns notifications on again). Then `bun run deploy`. This builds the web app, applies D1 migrations
  remotely and deploys to `ai.replogle.dev`. Sign up immediately after the
  first deploy; the first signup becomes the only account.
