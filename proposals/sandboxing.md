# Proposal: Sandboxing, with access requests and pluggable providers

**Status (2026-11-03): brainstorm, nothing built.**

Goal: code a thread runs (claude's tool calls, `npm install`, a dev server,
a terminal command) can't read `~/.ssh`, can't reach arbitrary hosts, and
can't touch files outside its workdir, unless the user grants it. When
something needs more, it **asks**, and the user answers from any device,
the way they answer claude's permission prompts today. How the isolation is
done (bubblewrap, Seatbelt, a dev container, a microVM, a cloud sandbox) is
a **provider** that a plugin contributes.

## What exists today

Four places start code that a repo or its dependencies control, all as the
user, with the login shell's whole environment:

| Where | What |
|---|---|
| `claude/claude.go` `Start` | claude, and every Bash tool call it makes. Gets `LoginEnv` plus `CLAUDE_CODE_OAUTH_TOKEN`. |
| `harness/acp.go` `startACP` | ACP agents. `os.Environ()`; doesn't use `proc.Start`. |
| `term/pty_unix.go` `Spawn` | terminals and every daemon-run process (`internal/process`). |
| `code/code.go` `Exec` | the MCP shell exec. |

Useful facts:

- Every thread already has its own working directory (`threads.Workdir`:
  project, worktree or Scratch folder), the natural writable root.
- The daemon's MCP server listens on `127.0.0.1` (`mcp/mcp.go`), and claude
  gets per-launch `--settings` and live `apply_flag_settings`
  (`Session.ApplyFlagSettings`).
- Plugins export services by name (`Host.Export` / `plugin.Lookup`), add to
  every claude launch (`ContributeAgent`) and add MCP tools (`AddTools`).
  External plugins speak JSON-RPC over stdio.

## Shape

```
          ┌──────────── sandbox plugin (built-in, core of this) ─────────────┐
 spawn ──▶│ policy resolver ─▶ provider.Prepare ─▶ wrapped exec.Cmd          │
 sites    │       ▲                                                          │
          │   grants store ◀── access broker ◀── requests (tool, proxy, logs)│
          │       │                      │                                   │
          │       ▼                      ▼                                   │
          │  egress proxy          UI prompt / timeline / push               │
          └──────────────────────────────────────────────────────────────────┘
 providers:  none · bwrap · landlock · seatbelt     (built-in)
             podman/devcontainer · gvisor · krun · apple-container · cloud   (plugins)
 brokers:    files · network · env · secrets (1Password, gh, keychain…)     (plugins)
```

### 1. Policy

A policy is plain data, so it can cross to an external plugin:

```jsonc
{
  "provider": "bwrap",                 // or "auto": best available here
  "fs": {
    "write": ["$WORKDIR", "$TMP"],
    "read":  ["$TOOLCHAINS", "~/.gitconfig"],
    "cache": ["~/.cache/pnpm"],         // writable, shared per project
    "hide":  ["~/.ssh", "~/.aws", "~/.config/gh", "~/.npmrc"]  // always, even if a parent is readable
  },
  "net": {
    "mode": "proxy",                   // none | proxy | open
    "allow": ["registry.npmjs.org", "github.com", "api.anthropic.com"],
    "loopback": ["$MCP_PORT"]
  },
  "env": { "pass": ["PATH", "LANG", "TERM", "GOPATH", "CARGO_HOME"] }
}
```

Layers, later wins: **device default → project → thread**, plus **grants**
on top. A preset per ecosystem (node, python, rust, go) fills in registries
and caches, detected from lockfiles.

**A repo can ask, never grant.** A checked-in `.everywhere/sandbox.json` (or
`devcontainer.json`'s `mounts`, `runArgs`, `privileged`) can *narrow* the
policy and *pre-declare requests* ("this project needs `crates.io` and
`~/.cargo/registry`"). Those requests appear once for the user to approve, as
one prompt. Otherwise cloning a malicious repo would hand it its own
sandbox exceptions.

Home threads default to `provider: none` (fixing the laptop needs the real
laptop). Worktree and Scratch threads default to `auto`.

### 2. Providers (pluggable)

```go
const ServiceSandbox = "sandbox"

type SandboxService interface {
    // Wrap rewrites cmd to run under the thread's policy. purpose is
    // agent | terminal | process | exec, for per-purpose policy and audit.
    Wrap(threadID, purpose string, cmd *exec.Cmd) (release func(), err error)
    // AddProvider registers an isolation backend.
    AddProvider(h Host, p Provider) (remove func())
    // AddBroker registers something that can satisfy access requests.
    AddBroker(h Host, b Broker) (remove func())
    // Request asks the user for access on a thread's behalf.
    Request(ctx context.Context, threadID string, r AccessRequest) (Grant, error)
}

type Provider interface {
    Info() ProviderInfo // id, title, os, strength (process|kernel|vm|remote), Live capabilities
    Available() error   // missing binary, unsupported kernel…: shown in settings
    // Prepare turns a command and policy into what to run. Data only, so an
    // external plugin can answer it over JSON-RPC.
    Prepare(ctx context.Context, l Launch) (Prepared, error)
    // Optional lifecycle for providers with a long-lived environment
    // (one container or VM per thread).
    Up(ctx context.Context, threadID string, p Policy) error
    Down(threadID string) error
    // Apply pushes a policy change into running sandboxes where the provider
    // can ("Live" in Info says which parts it can); otherwise it applies on
    // the next spawn.
    Apply(threadID string, p Policy) error
}

type Prepared struct {
    Argv  []string // full argv, e.g. ["bwrap", …, "--", "bash", "-lc", cmd]
    Env   []string
    Dir   string
    Files map[string][]byte // e.g. a generated Seatbelt profile, written by the host
}
```

The spawn sites call `Wrap` before `proc.Start` / PTY start; `proc` stays
about process groups. `Wrap` resolves the policy, picks the provider,
starts the thread's egress proxy, and fills in `cmd.Path/Args/Env/Dir`.

| Provider | Ships as | Strength | Live changes |
|---|---|---|---|
| `none` | built-in | — | — |
| `bwrap` (Linux) | built-in, needs `bwrap` | process (namespaces) | net (proxy); fs on next spawn |
| `landlock` (Linux ≥5.13) | built-in, no binary | process (fs only) | fs on next spawn; net only via proxy env |
| `seatbelt` (macOS) | built-in | process | net (proxy); fs on next spawn |
| `devcontainer` | plugin, podman/docker | container | net; fs needs recreate |
| `gvisor`, `krun` | plugin, or an option of `devcontainer` (`--runtime`) | kernel / microVM | same |
| `apple-container` | plugin (macOS 26+) | microVM per container | same |
| cloud (E2B, Daytona, Fly Machines…) | plugin | remote VM | needs workdir sync: later |

### 3. Asking for access

Three ways a request starts, from most precise to least:

1. **The agent asks.** An MCP tool from the sandbox plugin:
   ```
   sandbox_request {kind: "fs"|"net"|"env"|"secret", target, access: "read"|"write",
                    reason, scope?: "once"|"thread"|"project"}
   ```
   `ContributeAgent` adds a short system prompt: "commands run sandboxed;
   when one fails with a permission or network error, call
   `sandbox_request` with why, don't work around it." The tool blocks
   until the user answers, like an `ask` tool.
2. **The egress proxy sees it.** A blocked CONNECT to `evil.example` is
   exact, so it becomes a request automatically (deduplicated per host,
   rate-limited per thread). The connection fails fast instead of waiting,
   since `npm` would time out anyway; once allowed, a retry works.
3. **The provider notices a denial** (best effort): Seatbelt violations from
   `log stream --predicate 'sender == "Sandbox"'`, Landlock's audit records
   (Linux 6.15+), or a container's `EACCES` showing in output. These show up
   as "blocked" notes with an Allow button, not as prompts.

Answering:

- The prompt shows the thread, what is asking (agent / process name /
  terminal), the target, the reason and the provider's matching rule.
  Buttons: **Deny · Allow once · Allow for thread · Allow for project**.
  Push notification when nobody's watching, like claude's prompts.
- **Copy instead of mount** for files: "Give it a copy" puts the file in the
  thread's attachments (that plumbing exists) and works with every provider
  without a restart.
- Grants are stored (`sandbox_grants`: thread/project, kind, target,
  access, scope, granted_at, granted_by device) and listed in project
  settings, where they can be revoked. Every request and answer goes in the
  thread's timeline and an audit log.

Applying a grant:

- **Network**: instant; the proxy reads grants on every connection.
- **Files**: on the next spawn for `bwrap` / `seatbelt` / `landlock`. Each
  of claude's Bash calls is a new spawn, so this is mostly invisible when
  claude's tools are sandboxed rather than claude itself (below). A running
  dev server must be restarted; the prompt says so and offers to.
- **Containers**: network is instant; a new mount means recreating the
  container (offer it, or use the copy).

### 4. Brokers (pluggable): where the resources come from

A broker answers requests for things that aren't plain paths or hosts:

- `secret`: `GITHUB_TOKEN`, an npm token, a database URL. Plugins for
  1Password (`op`), `gh auth token`, the macOS keychain, `pass`. By default
  a secret is **injected by the proxy** as a header for its host (the
  sandbox never sees it); passing it as an env var is a separate, explicit
  choice.
- `net`: the built-in proxy. A plugin could swap in another (e.g. one that
  scans package tarballs with Socket or OSV before letting them through).
- `fs`: built-in.

```go
type Broker interface {
    Kinds() []string // "secret", …
    Describe(r AccessRequest) (BrokerOffer, error) // what it would give, shown in the prompt
    Fulfill(ctx context.Context, threadID string, g Grant) (Fulfilment, error) // env, proxy rule, file
}
```

### 5. Claude specifically

Two ways, chosen per project:

- **Sandbox claude's tools** (default). claude runs outside, and only the
  commands it starts are sandboxed: translate the policy into Claude Code's
  own sandbox settings (`--settings`, updated live with
  `apply_flag_settings`), pointing its network at our proxy so requests
  and grants are one system. The OAuth token stays in claude's process, out
  of reach of `npm install`. *To check: which proxy and filesystem settings
  Claude Code's sandbox exposes now.*
- **Sandbox claude itself** (container providers): claude runs inside with
  the host's binary mounted read-only. Stronger, but the token is inside
  too, unless the proxy can add it (e.g. `ANTHROPIC_BASE_URL` at a local
  forwarder that adds auth). *To check whether OAuth tokens work that way.*

ACP agents and terminals are always wrapped whole; they have no sandbox of
their own.

## Plan

1. **Env scrubbing + ACP on `proc.Start`.** Spawned tools get an allowlisted
   environment, not `LoginEnv`. Small, no new UI.
2. **`sandbox` plugin skeleton**: policy, `Wrap`, `none` + `bwrap` +
   `seatbelt` providers, egress proxy, wired into the four spawn sites.
   Project setting "Isolation". Proxy denials appear as timeline notes.
3. **Access requests**: `sandbox_request` tool, prompts in the app,
   `sandbox_grants`, grants in project settings.
4. **Claude tools sandbox** via `--settings`, sharing the proxy and grants.
5. **`devcontainer` provider plugin** (podman/docker, `--runtime` option for
   gVisor/krun), honoring `devcontainer.json` minus its escalations.
6. **Secret brokers** and proxy injection.
7. Later: Landlock fallback, Seatbelt/Landlock denial detection, Apple
   container, cloud providers, Windows (WSL2 or a container).

## Open questions

- **Shared caches** (`~/.cache/pnpm`, `~/.cargo/registry`): shared
  read-write is fast but lets one thread poison another. Per project, or
  read-only shared plus a per-thread overlay?
- **Request storms**: an install that touches 40 hosts. Batch requests per
  process in one prompt? Learn-mode ("allow and record for 2 minutes,
  then show me the list")?
- **Who can answer**: any signed-in device, or only ones marked trusted
  (the device itself, or with 2FA recently)?
- **Desktop and browser tools** act outside any sandbox by nature. Keep
  them per-thread opt-in, and off for sandboxed projects by default?
- **External providers are trusted code**: a provider plugin decides what
  "sandboxed" means. Mark them in settings, and require local consent
  (like `PermScreen`) to make one a project's provider?
