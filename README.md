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
# In the web UI (http://localhost:5173) sign up, click "Add device", copy the command, then:
EVERYWHERE_HOME=/tmp/ew EVERYWHERE_BIN_DIR=/tmp/ew/bin EVERYWHERE_NO_SERVICE=1 \
  EVERYWHERE_BINARY=$PWD/bin/everywhere sh -c '<paste command>'
EVERYWHERE_HOME=/tmp/ew /tmp/ew/bin/everywhere daemon -v
```

API security test (auth, 2FA, CSRF, sessions, rate limits) against a fresh local Worker:

```sh
cd apps/worker && EW_TEST_SERVER=http://localhost:8787 bun test/security.e2e.ts
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
- **Worker:** one-time setup: `openssl rand -base64 32 | tr -d '\n' | bunx wrangler secret put TOTP_KEY`
  (run in `apps/worker`). Then `bun run deploy`. This builds the web app, applies D1 migrations
  remotely and deploys to `ai.replogle.dev`. Sign up immediately after the
  first deploy; the first signup becomes the only account.
