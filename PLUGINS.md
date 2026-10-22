# everywhere — plugin system (proposal)

Turn most of what everywhere does into plugins that run on the same API a
third party would use, so features stop knowing about each other and new
ones (another agent harness, a database browser, a log viewer) don't touch
the core. Status: design, nothing built yet.

## What we learned from other plugin systems

| System | What we take | What we don't |
|---|---|---|
| **VS Code** | Built-in features are extensions on the public API (git, markdown). A declarative `contributes` manifest, so the UI can show menus and tab kinds before any plugin code loads, and activation is lazy. | Running plugin JS in the app's own JS realm. |
| **Figma** | Plugin UI runs in a sandboxed iframe and talks to the host over `postMessage`; the host exposes a narrow, typed API. | |
| **HashiCorp go-plugin / Terraform providers** | Out-of-process plugins for a Go host: a subprocess speaking RPC over stdio, a protocol version handshake, the host restarts a crashed plugin. | gRPC: we already speak JSON-RPC everywhere. |
| **LSP / MCP** | JSON-RPC over stdio, capability negotiation in an `initialize` handshake. MCP is already how claude gets our tools. | |
| **Grafana** | One plugin can span tiers (a backend in Go, a frontend panel); typed plugin kinds (panel, datasource, app). | Signing infrastructure, for now. |
| **Chrome extensions** | Permissions declared in the manifest and shown at install. | |
| **Claude Code plugins** | A plugin can contribute to claude itself: MCP servers, a system prompt, allowed tools, hooks. | |

Go's own `plugin` package is out: it needs cgo, is Linux/macOS only, and
must be built with the exact same toolchain and dependency versions as the
daemon. The daemon is static and CGO-free on purpose.

**We already have two plugins in miniature**, and the design generalizes
both:

- `everywhere-desktop` is an out-of-process worker: the daemon starts it,
  speaks `internal/desktop/ipc` over stdin/stdout, and refuses one from
  another protocol revision (`ipc.Version`). That's the daemon half of an
  external plugin.
- Dashboards are model-written TSX that the daemon bundles with esbuild and
  the app runs in a sandboxed iframe (`/dashboard`, `sandbox="allow-scripts"`,
  `connect-src 'none'`) behind a typed `postMessage` bridge
  (`apps/web/src/dashboard/bridge.ts`, `everywhere.d.ts`). That's the web
  half of an external plugin.

## Shape

A plugin has an id (`processes`), a version, a manifest and up to three
parts, one per tier:

```
daemon part   Go. RPC methods, data channels, MCP tools for claude, claude launch
              contributions, store tables, thread hooks, local HTTP, CLI commands.
web part      React. Tab kinds, thread header actions, sidebar badges, composer
              add-ons, timeline renderers, settings pages, routes.
worker part   TS, built-in only. Account-level routes, sealed secrets, hub messages,
              tools on the account MCP server (/mcp).
```

There are two ways to ship one, over the **same API**:

- **Built-in**: compiled into the daemon / bundled into the app / deployed
  with the Worker. Trusted. Every current feature becomes one of these.
- **External**: installed on a device. Its daemon part is a subprocess
  speaking JSON-RPC over stdio; its web part is TSX the daemon bundles and the
  app runs in a sandboxed frame. No worker part (a Worker can't load code at
  runtime without Workers for Platforms; see Open questions).

Build built-ins first. The API is shaped so that every call can cross a
process boundary later (JSON params, no shared pointers), so exposing it to
subprocesses is a transport, not a redesign.

### Core (not plugins)

What every plugin stands on, and what has to work for the app to load at all:

- Worker: auth, sessions, 2FA, devices and enrollment, the AccountHub
  (signaling, presence, `rpc` relay), the static app.
- Daemon: hub client, WebRTC peers, the `control` channel and its chunking,
  the store for projects / threads / tabs, `threads.workdir`, self-update,
  config, the plugin host.
- Web: login, the device connection (`lib/peer.ts`), the sidebar skeleton and
  thread rows, the thread page's tab strip, split view and preview tabs,
  settings shell, theming primitives.

## Manifest

The daemon is the source of truth for what's installed on a device. It
reports manifests in `device.info`, replacing today's flat `features`
array (`desktop`, `processes`, `gitStatus`, `scratch`…). The app gates UI on
`plugins.has("desktop")` instead of `features.includes("desktop")`, and can
draw a plugin's tab kinds and menus before loading its web code.

```jsonc
{
  "id": "processes",
  "version": "1.4.0",
  "api": 1,                                  // plugin API revision; host refuses others
  "title": "Processes",
  "requires": ["agent"],                     // must be present and started first
  "optional": ["telemetry", "dashboards"],   // used if present
  "permissions": ["exec", "pty", "fs.workdir", "agent.notify", "net.loopback"],
  "contributes": {
    "rpc": [
      { "method": "processes.list" },
      { "method": "processes.start", "remote": true },
      { "method": "processes.dashboard", "slow": true }
    ],
    "events":   ["processes.changed"],
    "channels": ["proc:"],
    "tools": [
      { "name": "process_start", "ask": true },
      { "name": "process_status" }, { "name": "process_output" }, "…"
    ],
    "tabs":     [{ "kind": "processes", "title": "Processes", "icon": "activity", "singleton": true }],
    "agentEvents": ["process"],
    "store":    { "tables": ["processes"] }
  }
}
```

Plugin-owned names are namespaced: RPC methods and events by
`<id>.`, channel labels by a prefix the plugin declares, MCP tools for
external plugins as `<id>_<tool>`. Built-ins keep today's names
(`process_start`, `browser_click`, `mcp__everywhere__…`) so stored timelines
and the web's renderers still match.

## Daemon API

```go
package plugin

type Plugin interface {
	Manifest() Manifest
	// Start registers contributions and starts work. Plugins start in
	// dependency order; one failing to start is reported, not fatal.
	Start(ctx context.Context, h Host) error
	Stop(ctx context.Context) error
}

type Host interface {
	// Contributions
	HandleRPC(method string, fn RPCFunc, opts ...RPCOption)   // Slow(), Remote()
	HandleChannel(prefix string, fn ChannelFunc)              // label after the prefix
	AddTools(tools ...mcp.Tool)                               // claude's everywhere MCP server
	ContributeAgent(fn func(AgentLaunch) AgentContribution)   // per claude start
	HandleHTTP(path string, h http.Handler)                   // on the loopback server

	// Platform
	Emit(event string, payload any)        // to every connected browser
	Bus() Bus                              // in-daemon events, see below
	Store() Store                          // tables the manifest declares, plus migrations
	DataDir() string                       // <data>/plugins/<id>
	Threads() Threads                      // get, workdir, tabs; read-only for most
	Service(id string) (any, bool)         // another plugin's exported service
	Export(svc any)                        // this plugin's service
	Config() Config                        // its keys in config.json, device-local
	Log() *slog.Logger
}

type RPCContext struct {
	Peer   PeerRef // nil when the call came over the hub (an MCP agent)
	Remote bool
}
type RPCFunc func(ctx context.Context, c RPCContext, params json.RawMessage) (any, error)

type ChannelFunc func(ctx context.Context, c ChannelContext, dc DataChannel)
// ctx is cancelled when the channel or its whole PeerConnection closes, which
// replaces peer.closeChannels' per-kind maps (terms, agents, browsers).
```

What this removes from `internal/peer`:

- `peer.go`'s channel `switch` on label prefixes becomes a lookup in the
  registered prefixes.
- `control.go`'s 150-line `call` with one shared params struct becomes one
  handler per method, each decoding its own params.
- The hard-coded list of slow methods (`device.checkUpdate`, `agent.login`,
  `desktop.start`…) becomes `Slow()` on the registration.
- `remote.go`'s denylist (`desktop.*`, `debug.peer`, `device.update`)
  becomes `Remote()` on the registration: off by default, so a new method
  isn't reachable over MCP until someone decides it should be.
- `callDesktop`'s special case for methods that need the calling peer is
  `RPCContext.Peer`.
- `NewServer`'s tool list and `claudeArgs`' allowed-tool list are built from
  what plugins registered (`ask: true` tools are left out of
  `--allowedTools`).

### Agent contributions

Today `claudeArgs` knows about the browser, processes, Scratch and the
desktop. Instead each plugin adds to a claude launch:

```go
type AgentLaunch struct{ ThreadID, Dir string; Scratch bool }
type AgentContribution struct {
	SystemPrompt string            // appended; e.g. Scratch's "you're on a machine",
	                               // the desktop's "you can see the screen"
	AllowedTools []string
	Env          map[string]string
	AddDirs      []string          // e.g. attachments
	MCPServers   map[string]any    // other MCP servers for this claude
}
```

### Bus

Typed in-daemon events, so plugins react to each other without imports:

```
thread.created  thread.archived  thread.restored  thread.deleted  tab.closed
thread.touched  (prompt or keystroke; clears done)
agent.turnStarted  agent.turnEnded  agent.toolUse {name}
peer.closed  daemon.stopping  daemon.updating
```

`process.Manager` stops a thread's processes on `thread.archived` instead of
the thread code calling it; the browser closes its page on `thread.deleted`;
`agent.toolUse` with a `browser_*` tool is what opens the browser tab.

### Services

Some dependencies are real calls, not events. A plugin exports a Go
interface (built-ins) or a set of RPC methods (externals), and dependents
look it up:

```go
type AgentService interface {
	// Tell a thread's claude something: now (starting a turn if idle) or
	// with the next prompt. What processes' notify does today.
	Notify(threadID string, n AgentNotice)
	ReadLog(threadID string, afterSeq int64) ([]Event, error)
	Append(threadID string, ev Event) error  // a `files` or `process` timeline event
}
```

### Store

Plugins keep their own tables in the daemon's SQLite. Each has its own
migration counter (a `plugin_migrations (plugin, version)` table, since
`PRAGMA user_version` is the core's), and can only touch tables its
manifest names. Existing tables move with their feature: `agent_events` and
the `agent_*` thread columns to `agent`, `processes` to `processes`. A
plugin's columns on `threads` (`scratch_dir`, `agent_session_id`…) move to
side tables keyed by thread id over time; the core keeps `kind`, `parent_id`
and `tab_state`, which are already generic.

## Web API

```ts
export default definePlugin({
  id: "processes",
  tabs: [{
    kind: "processes",
    title: "Processes",
    icon: ActivityIcon,
    singleton: true,
    captureInput: false,
    component: lazy(() => import("./processes-view")),
  }],
  composer: { above: lazy(() => import("./running-strip")) },
  sidebar: { threadBadge: (t) => (t.processes ? <RunningCount n={t.processes} /> : null) },
  timeline: {
    tools: [{ match: /^mcp__everywhere__process_/, icon: ActivityIcon, title, render }],
    events: { process: ProcessEvent },
  },
  on: {
    "agent.toolUse": ({ name }, ui) => { if (name === "mcp__everywhere__process_start") ui.openTab("processes", { focus: false }); },
  },
});
```

Contribution points, each from something the app hard-codes today:

| Point | Replaces |
|---|---|
| `tabs` | `TabKind`, `KIND_ICON`, `KIND_LABEL`, `renderPane`'s switch, `single = kind === "browser" \|\| kind === "processes"`, `inputCapture` |
| `threadKinds` | `ThreadKind = "terminal" \| "claude"`; a thread of a kind nobody provides shows "needs the X plugin" |
| `threadHeader` | the git chip, Scratch's "Make this a project…" / "Continue in…" |
| `sidebar` | running-process counts, the Scratch section, the device row's desktop button |
| `devicePage` | the Scratch composer, "Terminal in ~", projects |
| `composer` | dictation, prompt rewrite, the processes strip, attachments |
| `timeline.tools` | `tools.tsx`'s switch on tool names |
| `timeline.events` / `filters` | `files` and `process` events, "Changes to this computer" |
| `settings` | each page under `routes/_app/_workspace/settings/` |
| `routes` | `/d/$deviceId/desktop` |
| `on` (events) | `onBrowserUse`, `onDesktopUse`, `onProcessUse` props threaded through `AgentView` |
| `inbox` | `composer-inbox.ts` (annotations to the chat), as a host API |

The UI host gives a plugin `peer.call` scoped to its methods, `openChannel`
for its prefixes, `openTab`, tab state (`tabs.setState`), prefs, alerts,
theme, and the composer inbox.

### External plugins' web parts

The app's CSP is `script-src 'self'` and should stay that way, so external
plugin code never runs in the app's realm. It runs the way dashboards do:

- The daemon bundles the plugin's `web/index.tsx` with esbuild (the
  dashboard builder, generalized), with `react` and `everywhere` coming from
  the frame.
- The app shows it in a `sandbox="allow-scripts"` frame served by the Worker
  (`/plugin`, the dashboard frame generalized), with `connect-src 'none'`.
- The bridge carries: the plugin's own RPC and events, its channels (a
  `MessagePort` per data channel), theme variables, tab state and the UI
  host calls above.
- Declarative contributions (a sidebar badge's text, a header action, a tool
  card's title) come from the manifest and RPC results, so they need no frame.
  Only tabs, settings pages and timeline cards that want custom drawing get one.

The dashboard API (`useQuery`, `Card`, `LineChart`…) becomes the component
kit plugin frames get, so plugins look like the app.

## Worker parts

Built-in only, mounted from a list instead of `index.ts`'s `app.route` calls:

```ts
export interface WorkerPlugin {
  id: string;
  routes?: Hono<App>;                       // mounted at /api/<id>
  migrations?: string[];                    // D1, tracked per plugin
  hub?: Record<string, HubHandler>;         // daemon → hub messages, e.g. notify
  mcpTools?: McpTool[];                     // on /mcp
  onDaemonHello?(device, features): void;   // e.g. send the Claude token
}
```

External plugins that need a secret (an API key) or the account's AI models
get them through platform services instead of code: a sealed per-plugin
secret the hub hands to that plugin's daemon part (as the Claude token and
GitHub clone token travel today), and later a metered `ai.run` RPC.

## Permissions and trust

A daemon part, built-in or not, runs as the user, who can already open a
shell from the web app. Permissions don't sandbox it; they say what it uses,
gate the **host API** (a plugin can't call another's RPC, read its tables or
inject into claude without declaring it), and are shown when it's
installed.

| Permission | Allows |
|---|---|
| `fs.workdir` / `fs.read` / `fs.write` | the host's file APIs, in the thread's workdir or anywhere |
| `exec`, `pty` | starting processes, terminals |
| `net.loopback` | a route on the loopback HTTP server |
| `agent.tools` | MCP tools for claude (implied by `contributes.tools`) |
| `agent.notify` | messages to a thread's claude |
| `agent.read` | reading thread timelines |
| `agent.launch` | system prompt, env and MCP servers for claude |
| `browser` | the thread's Chromium page |
| `screen` | the desktop: capture and input. **Local consent**: see below |
| `secrets` | its sealed secret from the hub |
| `remote` | any of its methods being reachable over the hub (MCP agents) |

The rules that matter today carry over as host rules, not one-off checks:

- **Local consent.** Remote desktop stays off until `everywhere desktop
  enable` on the device, so neither a stolen web session nor the Worker can
  turn it on. Generalized: a permission marked local-consent (`screen`, and
  installing any external plugin) can only be granted from the device's CLI:
  `everywhere plugin install <path|url>`, `everywhere plugin enable <id>`.
  The web app can list, disable and configure plugins, not install them.
- **Not over MCP by default.** `Remote()` is opt-in per method, and a plugin
  with `screen` can't opt in.
- **Ask before running commands.** Tools declared `ask: true` stay out of
  claude's allowed tools, as `process_start` does today.

Later, on Linux, external daemon parts can run under Landlock or bubblewrap
restricted to what their permissions say, and their source can be pinned by
hash at install.

## External plugin process

```
<data>/plugins/<id>/          manifest, binary or script, web/, its data
everywhere plugin install | enable | disable | remove | list
```

- Started by the daemon when it's enabled, with `EVERYWHERE_PLUGIN_*` set,
  speaking JSON-RPC 2.0 over stdin/stdout, newline-delimited.
- `initialize {api, host}` → `{manifest}`; the host refuses another `api`.
- Then both directions: the host calls the plugin's registered methods,
  tools and channel handlers; the plugin calls `host/*` (emit, store, notify
  the agent, read a thread's workdir…), checked against its permissions.
- Channels: binary frames tagged with a stream id over the same pipe, or a
  Unix socket the host hands over for heavy ones (video-like traffic).
- A crash restarts it with backoff; its tabs show "the plugin stopped". It
  stops with the daemon and on `daemon.updating`.
- Any language. A small Go SDK and a TS SDK (Bun) wrap the protocol so
  writing one looks like writing a built-in.

## WebRTC

The core owns every PeerConnection's setup: ICE servers (the Worker's TURN
credentials), the interface filter, signaling through the hub, and closing
it all when the browser tab goes away. Plugins never get TURN credentials
or a socket of their own to the hub. Today's features use WebRTC in three
ways, and the API has one level for each.

### 1. Data channels on the device connection (most plugins)

Each browser tab has one PeerConnection per device, with `control` plus a
channel per open thing (`term:`, `agent:`, `browser:`, `proc:`, `file:`,
`upload:`). A plugin declares a label prefix and gets the channels opened
with it. Built-ins keep their prefixes; new plugins get `<id>/`.

```go
h.HandleChannel("proc:", func(ctx context.Context, c plugin.ChannelContext, ch plugin.Channel) {
	// c.Rest is the label after the prefix (the process id); c.Peer is the browser tab.
	// ctx ends when the channel or its PeerConnection closes.
})
```

```ts
const ch = ui.channels.open("proc:" + id, { ordered: true });          // or { ordered: false, maxRetransmits: 0 }
```

The host's `Channel` wraps pion's with what each feature now does by itself:
backpressure (`Send` blocks past a buffered-amount high-water mark, as
uploads do), chunking of JSON over 48 KB (as `control` does), and a
`ReadJSON`/`WriteJSON` pair, so a request/response protocol is a few lines.
Reliability is the opener's choice per channel.

Everything here shares one SCTP association, so it shares its bandwidth
and congestion control with every terminal and chat on that device. Fine
for terminals, files and chat; not for video, which is level 2.

### 2. A session: a PeerConnection of its own

Media wants its own connection: its own congestion control and media engine,
so it can't starve the terminals, and so it can be torn down alone. Remote
desktop does this today (`desktop.start` / `desktop.candidate` /
`desktop.stop` over `control`), and browser video does too, except that
Chromium's extension answers instead of pion. The host generalizes both into
**sessions**, signaled over `control` by the core rather than by each plugin:

```
rtc.open      {plugin, kind, sdp, params}  → {id, sdp}     browser offers
rtc.candidate {id, candidate}                               both ways (event from the daemon)
rtc.close     {id}
```

The plugin chooses who answers:

```go
// Host-answered: the host builds the PeerConnection (core ICE servers, its
// SettingEngine, plus the plugin's media engine and interceptors) and hands
// it over before answering, so the plugin adds tracks and channels.
h.HandleSession("desktop", plugin.SessionHost{
	MediaEngine: desktopCodecs,          // H.264/H.265, playout-delay ext, GCC
	Start: func(ctx context.Context, s plugin.Session, params json.RawMessage) error {
		track, _ := webrtc.NewTrackLocalStaticRTP(...)
		_, err := s.PC().AddTrack(track)
		...
	},
})

// Relayed: someone else answers (Chromium's capture extension). The host
// only carries the offer, answer and candidates, and still ties the
// session's life to the browser tab's.
h.HandleSession("browser.video", plugin.SessionRelay{
	Answer: func(ctx context.Context, s plugin.Session, offer string) (string, error) { ... },
	Candidate: func(s plugin.Session, c webrtc.ICECandidateInit) error { ... },
})
```

```ts
const s = await ui.rtc.open("desktop", { recvVideo: true, channels: [{ label: "input", ordered: false, maxRetransmits: 0 }, { label: "control" }], params: { mode, source } });
video.srcObject = s.stream;
```

Host-wide rules that are one-offs today:

- A session belongs to the browser tab that opened it and closes with it.
- Limits per plugin: how many at once, and whether a new one takes over
  (the desktop's "one per device; the old viewer is told who").
- Sessions are never opened over the hub: `rtc.*` isn't `remote`, so an MCP
  agent can't start a screen stream.
- The core reports each session's path (direct, Tailscale, TURN) and stats,
  so "this is relayed" warnings and the debug panel work for every plugin.

### 3. External plugins

A subprocess can't hold a pion object, so the host keeps the WebRTC side
and the plugin moves bytes:

- **Data channels**: the host terminates them and forwards each as a
  stream on the plugin's stdio connection (`{stream, data}` frames, binary
  or JSON), or for heavy traffic over a Unix socket per channel it hands
  over. Backpressure crosses the pipe as credits.
- **Media**: the plugin declares tracks in `HandleSession` (codec, kind),
  and writes encoded frames or RTP to a socket; the host packetizes and
  writes them to the track, and passes keyframe requests (PLI) and the
  bandwidth estimate back so the encoder can follow. That's exactly what
  `everywhere-desktop` does today: GStreamer encodes in the worker,
  `desktop/session.go` writes RTP to a `TrackLocalStaticRTP`. The desktop
  plugin becomes the reference for external media plugins.
- **Relay sessions** work as for built-ins: the plugin answers the SDP
  itself (its own WebRTC stack), and the host carries signaling.

On the web side a plugin's sandboxed frame never gets a PeerConnection
(it could reach any address over ICE). The app owns it:

- Channels reach the frame as a `MessagePort` per channel.
- Video and audio are drawn by the app: the frame asks for a host `<Video
  session=…>` slot that the app places over its region, with the same input
  capture as the desktop and browser tabs, and pointer and key events go to
  the frame or straight to a channel. (Transferring a `MediaStreamTrack`
  into the frame works only in Chromium, so it can be a fast path later, not
  the design.)

## Today's features as plugins

Each entry: what it contributes, then what it needs from the host or other
plugins. "Needs" is the point: it's the API we have to build.

### terminal (built-in, required)
- **Contributes**: thread kind and tab kind `terminal`; channel `term:`;
  `term.read` / `term.write` over the hub (remote); the mobile key row;
  "Run in terminal" (`tabs.create {kind: terminal, input}`) as a service
  others call.
- **Needs**: `pty`, `thread.workdir`, thread lifecycle events (stop the
  shell on archive / delete), `thread.touched` on keystrokes, writer/takeover
  state per channel.

### agent (Claude Code) (built-in)
The biggest one, and the one most others depend on. Making it a plugin is
what lets a second harness (Codex, the "harness-agnostic" goal in SPEC V1)
be another plugin of the same shape.
- **Contributes**: thread kind and tab kind `claude`; channel `agent:`;
  `agent.*` RPC (info, auth, login, setToken, updateClaude, read, request);
  worktrees (`git.info`, the workspace picker); attachments (channel
  `upload:`); the timeline, composer, permission / question / plan cards;
  resume banner, auto-recap, rewind, history; continue-after-update;
  Settings → Claude. Worker part: the sealed Claude token
  (`/api/claude/token`, `agent.setToken` on hello), the `notify` hub
  message's sending side.
- **Exports**: `AgentService` (notify, read log, append timeline events),
  and the bus events `agent.turnStarted/Ended`, `agent.toolUse`.
- **Needs**: `exec`, the store (`agent_events`, its thread columns),
  agent contributions from every other plugin, `fs.write` for worktrees,
  the push plugin to deliver its notifications.

**Other agents.** The agent plugin's engine (`internal/agent`) runs every
coding agent's threads; what's specific to one agent is its harness, behind
the engine's `process` interface. Claude Code's is `internal/claude`; any
agent that speaks the Agent Client Protocol (OpenCode, Gemini CLI…) goes
through `internal/harness`, which translates ACP into claude's stream. Each
agent is a thread kind with `view: "agent"`, drawn by the same agent view
(timeline, composer, permission cards, model and mode menus, attachments,
worktrees, history); claude-only controls (effort, thinking, rewind,
limits) hide for the others. Built-in agents are listed in
`harness.Agents`; an installed plugin adds one in `plugin.json`, needing
`exec` and no process of its own:

```jsonc
{
  "id": "gemini", "title": "Gemini CLI", "api": 1, "icon": "gemini.svg",
  "permissions": ["exec"],
  "contributes": { "agents": [{ "kind": "gemini", "title": "Gemini", "command": ["gemini", "--experimental-acp"] }] }
}
```

### browser (built-in)
- **Contributes**: tab kind `browser` (singleton, input capture); channel
  `browser:`; `browser_*` tools; video capture (the Chromium extension under
  `daemon/internal/browser/capture`); device presets; mouse mode; annotation
  layer.
- **Needs**: `exec` (Chromium), `browser`, `agent.toolUse` to open its tab,
  `thread.archived` (close the page, keep the URL) / `thread.deleted`, the
  composer inbox for annotations, ICE servers from the core.

### desktop (built-in; out-of-process already)
- **Contributes**: tab kind `desktop`, route `/d/$deviceId/desktop`, the
  sidebar's monitor button, `desktop.*` RPC (peer-scoped, never remote),
  `desktop_*` tools, an agent system prompt ("you can see the screen"), the
  timeline's screen-action filter, the CLI command `everywhere desktop
  enable`, the `everywhere-desktop` worker binary.
- **Needs**: `screen` (local consent), `RPCContext.Peer` to signal its own
  PeerConnection, ICE servers, `agent.toolUse` to open its tab, the composer
  inbox for annotations, a host notification on the device (session
  started / ended).

### files (built-in)
- **Contributes**: tab kind `files` with tab state (open file); `fs.list`;
  channel `file:` (reads, 25 MB, 200 MB for attachments).
- **Needs**: `fs.read`, `thread.workdir`. The `file:` channel is used by
  attachments, telemetry files and dashboards too, so it's a service
  (`Files.Serve(path, limit)`), not private.

### processes (built-in)
- **Contributes**: tab kind `processes`; channel `proc:`; `processes.*`
  RPC (remote); `process_*` tools (`process_start` asks); `process` timeline
  events; the strip above the composer; the sidebar's running count;
  widgets; `/progress` on the loopback server.
- **Needs**: `exec`, `pty`, the store (`processes`), `AgentService.Notify`
  for notices, `thread.archived` / `thread.deleted` to stop and remove,
  `daemon.stopping` (mark `lost`), optional telemetry (env vars for a run,
  OnProgress) and dashboards.

### telemetry (built-in)
- **Contributes**: the loopback ingest (`/log`, `/event`, `/attach`, OTLP);
  `telemetry.*` RPC; `telemetry.changed`; the Charts view inside the
  processes tab (a contribution to another plugin's view, see Open
  questions).
- **Needs**: `net.loopback`, `fs.write` in projects (`.everywhere/`), a
  run's token from processes. Depends on `processes`.

### dashboards (built-in)
- **Contributes**: `processes.dashboard`, `dashboard_build` /
  `dashboard_docs` tools, the frame and bridge. Worker part: `/dashboard`.
  Its frame and bridge are what external plugin UIs are built from, so the
  pieces move into the core's plugin frame and dashboards becomes a user of
  it.
- **Needs**: esbuild (a host service, shared with external plugins),
  telemetry queries, process state, `fs.read` in `.everywhere/dashboards`.

### scratch (built-in)
- **Contributes**: the Scratch project and a folder per thread (a
  `thread.created` hook), `threads.promote`, `threads.continueIn`,
  `scratch.usage`; the `projects_list`, `project_create` (cloning through
  the clone plugin's service when given a URL) and `thread_start` tools, so
  an agent can set up a project and hand work to a thread there; an agent
  system prompt and starting mode (`auto`); the
  sidebar section, device page composer, thread header actions, the
  "Changes to this computer" filter, "Run in terminal" on `sudo` blocks.
- **Needs**: a way to set a thread's workdir (today `scratch_dir`, resolved
  in `threads.workdir`, `ThreadShell` and `AgentThread`): a **workdir
  provider** hook the core asks, which worktrees (agent) also use;
  `AgentService` to read a conversation for `continueIn`; terminal's
  "Run in terminal".

### git (built-in)
- **Contributes**: `gitStatus`, fetches, the thread header's git chip,
  `git.info` for branch pickers.
- **Needs**: `exec` (git), `thread.workdir`, a timer while viewed.

### github (built-in)
- **Contributes**: Settings → GitHub, repos in the new-project dialog,
  `clone` RPC. Worker part: the OAuth app, sealed token, repo listing, and
  the clone token handed through the hub.
- **Needs**: `secrets`, `exec` (git clone), `fs.write` (the clone target),
  project creation from the core.

### share (`attach_file`) and done (`thread_done`) (built-in)
Small, which makes them the first to move.
- **share**: the `attach_file` tool and `files` timeline events. Needs
  `fs.read`, `AgentService.Append`, the files service.
- **done**: the `thread_done` tool, `threads.done`, the sidebar's "N done"
  group. Needs `agent.turnEnded` (only a completed turn counts) and
  `thread.touched` (clears it).

### account MCP (connected agents) (built-in)
- **Contributes**: worker part: `/mcp`, OAuth, `apps/worker/src/mcp-tools.ts`,
  Settings → Security's connected apps. Daemon part: `code.exec`,
  `read_file`… (`internal/code`).
- **Needs**: every plugin's methods marked `remote`, so its tool list grows
  with them instead of with `RemoteMethods`; `exec`, `fs.*`.

### push and alerts (built-in)
- **Contributes**: worker part: Web Push, VAPID, subscriptions, the `notify`
  hub message, `viewing`; web: Settings → Notifications, in-app alerts, the
  service worker's handling.
- **Needs**: a `notify(kind, thread)` service any plugin can call (today
  only the agent can), so a process finishing can notify too.

### dictation and rewrite (built-in)
- **Contributes**: composer buttons; worker parts `/api/speech`
  (Whisper) and `/api/prompt` (Gemma). Pure web + worker.
- **Needs**: a composer contribution point with access to the draft and
  the thread's recent text (`rewrite.ts` reads the timeline), Workers AI.

### appearance (built-in) and omarchy-theme
- **Contributes**: Settings → Appearance, stock Omarchy themes, and the
  browser extension (`extensions/omarchy-theme`, native messaging) that
  pushes the live theme.
- **Needs**: the core's theme tokens. Shows a **theme provider** point:
  an external source of palettes, which the extension is.

### web tabs (built-in, web only)
- **Contributes**: the browser-local `web` pane kind, opening links from
  processes and claude.
- **Needs**: a client-only tab kind (not stored on the daemon), which the
  tab contribution should support.

Left in the core: device updates (`device.update`, claude updates are the
agent's), project icons (could be a tiny plugin, but the sidebar draws them
before anything loads), the debug panel, preview tabs, idle threads and
drafts.

### Dependency graph

```
terminal ◀── scratch ──▶ agent ◀── processes ◀── telemetry ◀── dashboards
                          ▲  ▲         ▲
       share, done ───────┘  │         └── (notices)
       browser, desktop ─────┘ (agent prompt, toolUse)
       push ◀── agent, processes
       git ◀── agent (worktrees)      github ──▶ (projects, core)
```

## Migration

Each step ships on its own and leaves the app working.

1. **Registries in place.** Add `internal/plugin` (Host, registry, bus) and
   `apps/web/src/plugins/` (definePlugin, registry). The peer server
   dispatches registered RPC methods and channels before falling back to its
   switch. Move `done` and `share` onto it. Proves tools, RPC, timeline
   renderers and `AgentService.Append`.
2. **Tabs as contributions.** Move `files`, then `browser`; the thread page
   renders panes from the registry. `onBrowserUse` becomes `agent.toolUse`.
3. **processes, telemetry, dashboards** together, since they're tangled.
   Agent contributions replace `claudeArgs`' knowledge of them; `remote` on
   registrations replaces `remote.go`'s list for these.
4. **desktop and scratch.** Sessions (`rtc.*`, host-answered for the
   desktop, relayed for browser video), local consent, workdir providers.
5. **agent and terminal.** Now nothing in the core names claude. Thread kinds
   are a contribution.
6. **Manifests in `device.info`**, `features` kept alongside for one
   release so older apps still work, then removed.
7. **Worker plugins**: mount routes, hub handlers, MCP tools and migrations
   from a list.
8. **External plugins**: the stdio host, `everywhere plugin …`, the
   generalized frame, Go and TS SDKs, one example plugin outside the repo.

## Open questions

- **External plugins at all, or modularity only?** Steps 1–7 pay off on
  their own (features stop knowing about each other, a second harness gets
  easy). Step 8 is the big one, and only worth it if plugins from outside
  this repo are wanted.
- **Account-level external plugins.** A plugin that's not tied to a device
  (an integration with a SaaS) has nowhere to run but the Worker. Workers for
  Platforms' dispatch namespaces could host them, or we say "pick a device".
- **Plugins contributing into other plugins' views** (telemetry's Charts
  inside the processes tab, a plugin adding a timeline filter). Probably named
  slots a plugin offers (`processes.views`), as VS Code's view containers.
- **Distribution.** A directory on the device to start; a list in the app
  (per account, installed on chosen devices) later, still installed through
  the CLI for consent.
- **Per-device or per-account enablement.** Probably per device for the
  daemon part (it's that machine's code), with the web part following
  whichever devices have it.
