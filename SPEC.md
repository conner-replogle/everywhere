# everywhere — V1 spec

Run terminals on any of your machines and reach them from a website. V1 is
terminal-only and harness-agnostic: an agent (Claude, Codex, …) is just
something you run in a terminal. Harness-specific support comes later.

## Glossary

- **Device**: a machine running the `everywhere` daemon, enrolled to an account.
- **Project**: a named directory on a device (e.g. `~/code/api` on `hetzner-1`).
  Every device has an implicit **home** project (`$HOME`) for loose terminals.
- **Thread**: a named, persistent terminal slot inside a project. Its shell is
  a child process of the daemon, spawned lazily when a client opens the thread.
- **Client**: a browser tab on the website (later: desktop/mobile apps, which
  are viewers only).
- **Writer**: the one client allowed to type into / resize a thread. Everyone
  else attached to it sees a live read-only view.
- **Hub**: the per-account Durable Object that relays signaling and presence.

## Architecture

```
 browser ──HTTPS/WS──▶ Worker (ai.replogle.dev) ◀──WS── daemon (Go)
    │                    ├─ D1: users, sessions, devices, enroll tokens
    │                    └─ AccountHub DO: signaling + presence
    │                                                     │
    └────────── WebRTC data channels over Tailscale ──────┘
                (all project/thread/terminal data)
```

- The Worker never sees project, thread, or terminal data. Those live only on
  the daemon (SQLite) and travel over WebRTC.
- Tailscale is assumed on every device, the viewing device included. ICE uses the
  daemon's tailnet host candidate. No TURN. If a device can't be reached, the UI
  says so.
- The Worker is trusted (no signaling-key pinning in V1).

## Decisions

| Area | Decision |
|---|---|
| Tenancy | Self-hosted, single user; every row keyed by `account_id` for later multi-tenant |
| Daemon | Go, static binary, linux amd64/arm64 (macOS built, unsupported) |
| Data path | WebRTC (pion) over Tailscale; Worker only does signaling |
| Signaling | Hibernatable WebSockets on one `AccountHub` DO per account |
| Worker storage | D1 for auth + device registry; DO holds sockets only |
| Local storage | SQLite on daemon (`modernc.org/sqlite`, CGO-free) |
| Session survival | None. PTYs are daemon children; if the daemon dies, threads get a fresh shell on next open |
| Scrollback | In-memory ~1MB ring buffer per running thread; lost with the shell |
| Multi-viewer | One writer, others live read-only, "Take over" button |
| Auth | Username/password; first signup wins, signup closes after one user |
| Enrollment | One-use install link generated in the web UI (15 min TTL) |
| Frontend | React + Vite + TanStack Router + Tailwind + shadcn/ui + xterm.js |
| Distribution | Public GitHub releases (`conner-replogle/everywhere`) via goreleaser |
| Domain | `ai.replogle.dev` (Worker custom domain; overrides the `*.replogle.dev` wildcard) |

## Repo layout

Bun workspaces monorepo:

```
apps/worker/       Hono Worker, AccountHub DO, D1 migrations, install.sh template
apps/web/          Vite + React SPA, served as Worker static assets
packages/protocol/ TS types for hub WS messages + data-channel RPC (Go mirror in daemon)
daemon/            Go module github.com/conner-replogle/everywhere/daemon
```

## Worker

### D1 schema

```
users          (id, username UNIQUE, password_hash, created_at)          -- account_id = user id for now
sessions       (id_hash PK, user_id, expires_at)
devices        (id, account_id, name, hostname, os, arch, version,
                credential_hash, created_at, last_seen_at, revoked_at)
enroll_tokens  (token_hash PK, account_id, expires_at, used_at, device_id)
```

Passwords use PBKDF2-SHA256 via WebCrypto. Sessions are random 32-byte tokens in an
`HttpOnly; Secure; SameSite=Lax` cookie, stored hashed.

### HTTP routes

```
POST   /api/auth/signup        only when users is empty
POST   /api/auth/login | /api/auth/logout
GET    /api/auth/me            also reports whether signup is open
GET    /api/devices            registry + last_seen
PATCH  /api/devices/:id        rename
DELETE /api/devices/:id        revoke: sets revoked_at, hub closes its socket
POST   /api/enroll-tokens      → { command: "curl -fsSL https://ai.replogle.dev/i/<token> | sh" }
GET    /i/:token               install.sh with server URL + token baked in (does not consume token)
POST   /api/daemon/enroll      { token, hostname, os, arch, version } → { deviceId, credential }  (consumes token)
GET    /api/ws                 browser WS (session cookie) → AccountHub
GET    /api/daemon/ws          daemon WS (Bearer credential) → AccountHub
*                              static SPA assets, SPA fallback
```

### AccountHub DO

Addressed with `idFromName(accountId)`. Uses the hibernation API: `acceptWebSocket` with
tags `device:<id>` / `client:<connId>`, identity in `serializeAttachment`, and
`setWebSocketAutoResponse` for ping/pong.

Messages (JSON):

```
daemon → hub   { t: "hello", version }
hub → client   { t: "presence", online: [deviceId] }            on client connect
hub → client   { t: "presence.update", deviceId, online }
client → hub   { t: "signal", to: deviceId, sid, data }         data = SDP offer | ICE candidate
hub → daemon   { t: "signal", from: connId, sid, data }
daemon → hub   { t: "signal", to: connId, sid, data }           answer | candidates
hub → client   { t: "signal", from: deviceId, sid, data }
hub → any      { t: "error", code, message }                    e.g. daemon_too_old, device_offline
```

The hub updates `devices.last_seen_at` on daemon connect and disconnect. `MIN_DAEMON_VERSION`
is a Worker var; the hub rejects older daemons with `daemon_too_old`.

## Daemon

### CLI

```
everywhere enroll --server URL --token T   exchange token for credential, write config
everywhere daemon                          run (what systemd starts)
everywhere add [path] [--name N]           register a project (writes SQLite directly)
everywhere status | version | update | uninstall
```

### Files

- `~/.config/everywhere/config.json`: server URL and device id
- `~/.config/everywhere/credential`: 0600
- `~/.local/share/everywhere/everywhere.db`: SQLite, WAL mode

```
projects (id, name, path UNIQUE, created_at)                -- home project seeded on first run
threads  (id, project_id, name, created_at, last_opened_at, had_session BOOL)
```

### Runtime

- Keeps a WS to `/api/daemon/ws`, reconnecting with backoff.
- On a signal from a new `sid`: creates a pion PeerConnection with trickle ICE
  (STUN `stun.cloudflare.com` is harmless extra; the tailnet host candidate
  does the work). One PeerConnection per browser tab.
- **`control` data channel**: JSON request/response plus events:
  - `projects.list | create | rename | delete`
  - `threads.list | create | rename | delete`
  - `fs.listDirs { path }`: directory names only, never file contents
  - events: `projects.changed`, `threads.changed`
- **`term:<threadId>` data channel** (one per open terminal):
  - binary messages carry raw PTY bytes in both directions
  - string messages carry JSON control:
    - client → daemon: `{t:"attach",cols,rows}` (first), `{t:"resize",cols,rows}`,
      `{t:"takeover",cols,rows}`
    - daemon → client: `{t:"writer", you: bool}`, `{t:"exited", code}`, `{t:"error", message}`
- **Terminal manager**:
  - A thread's shell is spawned on first attach if it isn't running: the user's
    login shell from `/etc/passwd`, run as `-l`, in the project dir, with
    `TERM=xterm-256color` and `COLORTERM=truecolor`.
  - If `had_session` is set, the terminal first shows
    `[new shell — previous session ended]`.
  - On attach, the ring buffer is replayed.
  - The first attacher becomes writer. Input and resize from non-writers are
    dropped. "Take over" moves the writer role and resizes the PTY to the new
    writer's size. When the writer detaches, the most recently attached client
    is promoted.
  - When the shell exits, clients get `exited`. The next attach respawns it.
    Only Delete removes a thread.

### Install (`curl -fsSL https://ai.replogle.dev/i/<token> | sh`)

1. Detect arch (`x86_64`→amd64, `aarch64`→arm64) and download the latest
   release tarball plus checksums from GitHub, then verify.
2. Install the binary:
   - Non-root: `~/.local/bin/everywhere`, plus a `systemd --user` unit and
     `loginctl enable-linger $USER`.
   - Root: `/usr/local/bin/everywhere`, plus a system unit.
3. `everywhere enroll --server https://ai.replogle.dev --token <token>`.
4. Enable and start the unit. Without systemd, print how to run `everywhere daemon`.

## Web app

```
/login, /signup                 signup only while no user exists
/                               devices with live presence; offline = greyed, empty
/d/$deviceId                    project + thread sidebar (via control channel)
/d/$deviceId/t/$threadId        xterm.js terminal (WebGL, fit addon), writer banner + Take over
/settings/devices               add device (shows install command), rename, revoke
```

A PeerConnection to a device is opened lazily the first time it's viewed and
reused for every thread on that device in that tab.

## Milestones

1. **Scaffold**: monorepo, wrangler config (D1 + DO + assets), Go module, lint/format.
2. **Spike**: browser ↔ pion data channel over Tailscale, signaled through the
   AccountHub. Echo only. Proves the riskiest part first: Chrome mDNS-masks its
   own host candidates, so we depend on the daemon's tailnet candidate plus
   peer-reflexive discovery.
3. **Auth + devices + enrollment**: D1 schema, signup/login, enroll tokens,
   install.sh, daemon `enroll`.
4. **Terminal**: SQLite, projects/threads RPC, PTY manager, writer/takeover.
5. **Web UI**: device list, sidebar, terminal view, add-device flow, directory picker.
6. **Ship**: goreleaser + GitHub Action on tag, deploy to `ai.replogle.dev`.

## Before deploying

- `ai.replogle.dev` currently resolves only via the `*.replogle.dev` wildcard.
  The Worker custom domain adds a specific record that overrides it, so nothing
  needs deleting and the wildcard stays.
- Two Cloudflare accounts are visible. Pin `account_id = c6f8f04408d88cfe47437164e1c4ace2`
  ("Conner Replogle Account") in `wrangler.jsonc`.
- Deploy, then immediately visit `/signup` (first signup wins).

## Out of scope for V1

Mobile app, desktop app, harness integrations (resume, structured agent UIs),
TURN / non-Tailscale access, multi-user signup, key pinning or E2E verification,
sessions surviving daemon restart, persisted scrollback, official macOS support,
Windows, daemon auto-update.
