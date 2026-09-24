# everywhere — V1 spec

Run terminals on any of your machines and reach them from a website. V1 is
terminal-only and harness-agnostic: an agent (Claude, Codex, …) is just
something you run in a terminal. Harness-specific support comes later.

## Glossary

- **Device**: a machine running the `everywhere` daemon, enrolled to an account.
- **Project**: a named directory on a device (e.g. `~/code/api` on `hetzner-1`).
  Every device has an implicit **home** project (`$HOME`) for loose terminals.
- **Thread**: a named, persistent slot inside a project, either a
  **terminal** (a shell, spawned lazily when a client opens the thread) or a
  **claude** thread (a Claude Code conversation; see Claude threads).
- **Tab**: a view opened inside a thread next to the thread itself: a
  terminal, a claude conversation, the thread's browser, or a files view.
  See Tabs.
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

- Browsers never send project, thread, or terminal data through the Worker.
  It lives only on the daemon (SQLite) and travels over WebRTC. The exception
  is agents using the MCP endpoint (see MCP): their requests and the answers
  are relayed through the hub.
- ICE prefers direct paths: LAN, Tailscale (the daemon's tailnet host candidate
  plus peer-reflexive discovery) and NAT traversal via STUN. Cloudflare Realtime
  TURN is the fallback. The Worker mints 12-hour credentials for browsers
  (`GET /api/ice-servers`) and daemons (`GET /api/daemon/ice-servers`), so it
  still works when the viewer isn't on the tailnet or the daemon's network blocks
  UDP. Relayed traffic stays DTLS-encrypted end to end.
- The Worker is trusted (no signaling-key pinning in V1).

## Decisions

| Area | Decision |
|---|---|
| Tenancy | Self-hosted, single user; every row keyed by `account_id` for later multi-tenant |
| Daemon | Go, static binary, linux amd64/arm64 (macOS built, unsupported) |
| Data path | WebRTC (pion): direct/Tailscale first, Cloudflare TURN fallback; Worker only does signaling |
| Signaling | Hibernatable WebSockets on one `AccountHub` DO per account |
| Worker storage | D1 for auth + device registry; DO holds sockets only |
| Local storage | SQLite on daemon (`modernc.org/sqlite`, CGO-free) |
| Session survival | None. PTYs are daemon children; if the daemon dies, threads get a fresh shell on next open |
| Scrollback | In-memory ~1MB ring buffer per running thread; lost with the shell |
| Multi-viewer | One writer, others live read-only, "Take over" button |
| Auth | Username/password (PBKDF2) plus optional TOTP 2FA with recovery codes; first signup wins; reset via `bun run reset-password` |
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
daemon → hub   { t: "hello", version, features? }                features: ["rpc"]
hub → client   { t: "presence", online: [deviceId] }            on client connect
hub → client   { t: "presence.update", deviceId, online }
client → hub   { t: "signal", to: deviceId, sid, data }         data = SDP offer | ICE candidate
hub → daemon   { t: "signal", from: connId, sid, data }
daemon → hub   { t: "signal", to: connId, sid, data }           answer | candidates
hub → client   { t: "signal", from: deviceId, sid, data }
hub → any      { t: "error", code, message }                    e.g. daemon_too_old, device_offline
hub → daemon   { t: "rpc", id, method, params }                 from the MCP endpoint (RemoteMethods)
daemon → hub   { t: "rpc.result", id, result? | error? }
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
threads  (id, project_id, kind, name, created_at, last_opened_at, had_session BOOL,
          agent_session_id, agent_model, agent_permission_mode)
           parent_id (tabs), tab_state
agent_events (thread_id, seq, at, event JSON)               -- claude thread log
```

Migrations are append-only and tracked in `PRAGMA user_version`.

```
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

### Tabs

A tab is a `threads` row with `parent_id` set to its thread (tabs don't nest;
feature `tabs`). Its kind is terminal, claude, browser or files. Terminal and
claude tabs are threads in their own right, on their own `term:` / `agent:`
channels, and run where their thread runs: a tab of a claude thread in a
worktree works in that worktree (a claude tab records it as its own, and
closing the tab never removes it). `threads.list` leaves tabs out.

- `tabs.list {threadId}`, `tabs.create {threadId, kind, name?}`,
  `tabs.close {id}` (deletes it, stopping its shell or claude),
  `tabs.setState {id, state}` (the view's own state, e.g. the files view's
  open file). Rename with `threads.rename`. Archiving or deleting a thread
  does the same to its tabs.
- `threads.workdir {id}`: where the thread works (worktree or project).
- `fs.list {path}`: a directory's entries with sizes, directories first.
- **`file:<id>` channel**, one per read: `{t:"read", path}` →
  `{t:"start", size, modTime}`, binary chunks, `{t:"end"}` or `{t:"error"}`.
  Files over 25 MB are refused.
- **Browser**: each thread has its own page in the daemon's Chromium, on
  `browser:<threadId>` (a tab's id means its thread's page). A browser tab
  shows it, so a thread has at most one; claude's browser tools, from the
  thread or any of its claude tabs, drive the same page. It opens by itself
  when claude starts using the browser, unless the user closed it in the last
  two minutes. Closing the browser tab or deleting the thread closes the page;
  archiving closes it but remembers its URL.

### Install (`curl -fsSL https://ai.replogle.dev/i/<token> | sh`)

1. Detect arch (`x86_64`→amd64, `aarch64`→arm64) and download the latest
   release tarball plus checksums from GitHub, then verify.
2. Install the binary:
   - Non-root: `~/.local/bin/everywhere`, plus a `systemd --user` unit and
     `loginctl enable-linger $USER`.
   - Root: `/usr/local/bin/everywhere`, plus a system unit.
3. `everywhere enroll --server https://ai.replogle.dev --token <token>`.
4. Enable and start the unit. Without systemd, print how to run `everywhere daemon`.

### Claude threads

A claude thread runs the user's own `claude` CLI (found on PATH, via the
login shell, or in `~/.local/bin`) with the login shell's environment, in the
project directory. The daemon speaks Claude Code's stream-json protocol, the
same one the Agent SDK uses (`internal/claude`):

- **Process lifecycle** (`internal/agent`):
  - One `claude` process per active thread, started on the first prompt and
    resumed with `--resume <session>` after that.
  - It keeps running with no viewers attached.
  - It is stopped after 30 idle minutes; the next prompt resumes it.
  - Each thread is an actor goroutine that owns its state.
- **Event log**: Claude's output becomes a persisted event log (`agent_events`,
  per-thread `seq`) plus live state: status, pending permission prompts,
  streamed text, mode and model.
- **`agent:<threadId>` data channel** (JSON both ways):
  - client → daemon:
    - `attach {afterSeq}` must come first; it replays the events after
      `afterSeq`, then `synced`
    - `send {text}`: a prompt. While a turn runs, it is folded into that turn.
    - `interrupt`
    - `respond {requestId, decision, message?, answers?}`, where decision is
      allow | allowSession | deny
    - `setMode`, `setModel`
  - daemon → client:
    - `event {seq, at, event}`
    - `synced`
    - `state {state}`, pushed on every change
    - `delta {key, text}`: streamed text, not persisted
    - `error`
- **Clients**: any attached client may prompt and answer; the first answer wins.
- **Workspace** (chosen before the first prompt, then fixed): the project
  checkout, or a new git worktree from a chosen base branch, made on the first
  prompt with `git worktree add -b everywhere/<thread> <data>/worktrees/<project>-<id>/<thread> <base>`.
  Uncommitted changes don't carry over. A missing worktree is recreated on its
  branch. Deleting the thread removes the worktree (unless asked not to); the
  branch is kept. `git.info {projectId}` lists branches for the picker.
- **Attachments**: each file goes over its own `upload:<id>` channel (start
  frame, binary chunks, end; 10 MB per image, 50 MB per file) into
  `<data>/attachments/<thread>/<id>/`. On `send`, images become image blocks,
  and every attachment is named in the prompt as
  `[Attached <kind> "<name>" is saved at: <path>]`, with the directory added
  to claude's allowed dirs.
- **Context**: `get_context_usage` after each turn, at start and after
  compaction, plus live estimates from each API call's input usage; the last
  value is kept for stopped threads.
- **Models before the first prompt**: `agent.info` starts a throwaway claude
  for its initialize handshake (no prompt, no API use) and caches the models
  and account for 10 minutes.
- **Continue after update**: `device.update` marks threads with a turn in
  progress; on startup each is resumed once with "Continue where you left off."
- **Thread list**: `threads.list` reports `running` and `agentStatus`
  (stopped | starting | idle | working | waiting | error).

## MCP (agents such as a ChatGPT connector)

`POST /mcp` is an MCP server (Streamable HTTP, stateless JSON responses) that
lets another agent use the account: list devices, projects and threads, read
threads, create projects and threads, send messages, answer permission prompts
and type into terminals. Tools are in `apps/worker/src/mcp-tools.ts`. It also
has `search` and `fetch`, the pair ChatGPT expects.

- **Auth**: OAuth 2.1 (`apps/worker/src/oauth.ts`). Discovery through
  `/.well-known/oauth-protected-resource[/mcp]` and
  `/.well-known/oauth-authorization-server`. Clients register themselves at
  `/oauth/register` (RFC 7591). `/oauth/authorize` requires the normal web
  sign-in and then shows a consent page; only S256 PKCE is accepted. Access
  tokens last 1 hour and refresh tokens 30 days; refresh tokens rotate. Each
  approval is a grant (`oauth_grants`), listed and revocable under Settings →
  Security. Changing or resetting the password revokes every grant.
- **Transport**: tool calls reach daemons through the AccountHub as `rpc`
  messages on the daemon's existing socket. Daemons that announce the `rpc`
  hub feature serve `RemoteMethods` (`daemon/internal/peer/remote.go`): the
  control methods (except `debug.peer` and `device.update`), plus
  `threads.get`, `threads.search`, `agent.read` (log page plus state,
  optionally waiting for a turn to finish), `agent.request` (any agent-channel
  request except attach/history), `term.read` (scrollback as plain text) and
  `term.write` (typing; bypasses the writer role).

## Web app

```
/login, /signup                 signup only while no user exists
/                               devices with live presence; offline = greyed, empty
/d/$deviceId                    project + thread sidebar (via control channel)
/d/$deviceId/t/$threadId        terminal: xterm.js (WebGL, fit addon), writer banner + Take over
                                claude: timeline, permission/question/plan cards, composer
                                tab strip: the thread, then its tabs; ?tab=<id> picks one
/settings/devices               add device (shows install command), rename, revoke
/settings/security              password, 2FA, sessions, connected apps (MCP URL, revoke grants)
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

Mobile app, desktop app, harnesses other than Claude Code,
multi-user signup, key pinning or E2E verification,
sessions surviving daemon restart, persisted scrollback, official macOS support,
Windows, daemon auto-update.
