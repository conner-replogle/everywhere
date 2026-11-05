# everywhere

Use the terminals, Claude Code sessions, browsers and desktops of all your
machines from one web app.

A small daemon runs on each machine. A Cloudflare Worker that you deploy
handles sign-in and connects your browser to each machine. Your data then
travels directly between the browser and the machine over WebRTC, without
passing through the Worker.

```
 browser ──HTTPS──▶ your Worker (Cloudflare) ◀──WSS── everywhere daemon
    │                sign-in, devices, signaling            │
    └──────────── WebRTC, end to end (DTLS) ─────────────────┘
          terminals · Claude threads · files · browser · desktop
```

## Features

- **Terminals** on any machine, live in the browser, with take-over between tabs.
- **Claude Code threads** that keep running while you're away, with
  worktrees, attachments, permission prompts and push notifications.
- **Scratch:** ask Claude to work on the machine itself, outside any project.
- **Assistant:** one voice or text conversation about all your machines and
  threads that can prompt and start threads for you (on Workers AI).
- **Remote desktop** for Hyprland and Windows, low latency over WebRTC (opt-in on each machine).
- **Agent browser:** each thread gets a Chromium page that you and Claude share.
- **Processes and dashboards** for dev servers and long-running jobs.
- **Desktop app** (Electron) with web tabs that can open a machine's localhost.
- **Plugins** for adding thread kinds, tools and UI. See [PLUGINS.md](PLUGINS.md).

## Self-hosting on Cloudflare

You need a Cloudflare account with a domain on it, plus [Bun](https://bun.sh).

```sh
git clone https://github.com/conner-replogle/everywhere
cd everywhere && bun install
cd apps/worker
bunx wrangler login
bunx wrangler d1 create everywhere      # note the database_id it prints
```

Edit `apps/worker/wrangler.jsonc` for your account:

| Setting | Set it to |
|---|---|
| `account_id` | your Cloudflare account ID |
| `routes[0].pattern` | the hostname to serve on, e.g. `everywhere.example.com` |
| `vars.PUBLIC_URL` | `https://` plus that hostname |
| `d1_databases[0].database_id` | the ID from `d1 create` |
| `vars.TURN_KEY_ID` | a Realtime TURN key ID, or `""` to skip TURN (see below) |

Set the secrets:

```sh
openssl rand -base64 32 | tr -d '\n' | bunx wrangler secret put TOTP_KEY   # encrypts 2FA seeds and tokens
bun run vapid-key | bunx wrangler secret put VAPID_KEY                    # signs push notifications
```

Deploy from the repo root. This builds the web app, applies the database
migrations and deploys the Worker:

```sh
cd ../.. && bun run deploy
```

Open your URL and **sign up right away**. The first account is the only one,
and signup closes after it.

### Optional

- **TURN relay**, for networks that block direct connections: create a
  Realtime TURN key in the Cloudflare dashboard. Put its ID in `TURN_KEY_ID`
  and run `bunx wrangler secret put TURN_API_TOKEN`. Without it, connections
  only work where a direct path or Tailscale gets through.
- **GitHub** (connect an account and clone repos onto machines): create a
  GitHub OAuth app with the callback `<PUBLIC_URL>/api/github/callback`, then
  set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` as secrets.

Keep `TOTP_KEY` once 2FA is in use: rotating it makes the stored 2FA seeds
unreadable.

## Adding a machine

In the web app, click **Add device** and run the one-time command it shows
on the machine:

```sh
curl -fsSL https://<your-host>/i/<token> | sh              # Linux, macOS
irm https://<your-host>/i/<token>/windows | iex            # Windows (PowerShell)
```

The command installs the daemon, enrolls the machine, and starts it as a
service. Remote desktop on macOS is in progress.

On the machine:

```sh
everywhere add ~/code/api        # register a project (also possible from the web app)
everywhere status
everywhere update
everywhere desktop enable        # allow remote desktop on this machine
everywhere uninstall [--purge]
```

Remote desktop on Linux needs Hyprland 0.56 or later, a VA-API GPU,
GStreamer's `va` plugins and `wl-clipboard`.

## Desktop app

Installers for Linux, macOS and Windows are attached to each
[release](https://github.com/conner-replogle/everywhere/releases). Point the
app at your own server with `EVERYWHERE_URL=https://<your-host>` or
`--url=https://<your-host>`.

## Updating

Pull, then run `bun run deploy` again. Machines update with
`everywhere update`, or from the app.

## Locked out?

There is no email reset. From a machine logged in to your Cloudflare account:

```sh
bun run reset-password <username>                 # prints a temporary password
bun run reset-password <username> --disable-2fa   # also removes 2FA
```

## Development

```sh
bun install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
bun run --filter @everywhere/worker migrate:local
bun run build && bun run dev          # Worker on :8787, Vite on :5173
cd daemon && go build -o bin/everywhere ./cmd/everywhere
```

The design is documented in [SPEC.md](SPEC.md) and the plugin API in
[PLUGINS.md](PLUGINS.md).
