# Proposal: Scratch mode, general computer work per device

**Status (2026-10-07): implemented on this branch; SPEC.md's "Scratch" section
is the current design.** Not built: "Move to…" a new location (promote keeps
the folder where it is; "Continue in a project" covers moving on).

Brainstorm, not a spec. Goal: "my laptop is acting up", "convert these
files", "what's eating my disk" get their own obvious way in, without picking
or registering a project directory first.

Conner's direction: this area is **Scratch mode**. You pick a device and start
a thread. It runs in a **dedicated, Everywhere-owned scratch folder** on that
device. Sessions and files persist, and nothing is deleted automatically.
It's meant for short, ad hoc computer tasks outside projects.

## What exists today

- **Home project.** The daemon seeds one per device (`is_home`, `$HOME`,
  `store.go`). The sidebar sorts it after real projects with a house icon and
  no rename or delete. It's the de facto general slot today, but its cwd is
  the user's real home directory, so any files claude makes land loose in
  `~`.
- **MCP `create_thread`** falls back to the home project when no `project_id`
  is passed.
- **No device page.** `/d/$deviceId` redirects to `/`. A device is a footer row
  in the sidebar: presence, `os/arch · version`, Remote desktop, and a menu
  (New project…, Remote desktop, Connection debug).
- **`/` says "Pick a thread":** press + on a project.
- **Per-thread working directories already exist:** the claude workspace
  (`AgentWorkspace{mode: local|worktree, path}`) gives a thread its own
  directory under `<data>/worktrees/…`, and `threads.workdir` reports it.
  Attachments live under `<data>/attachments/<thread>/`.
- **Desktop tools** are listed for every claude thread once the device ran
  `everywhere desktop enable`, and they run without a prompt. On Windows they
  act on the user's own screen. `desktop.*` is never reachable over MCP.
- **Offline devices.** Thread lists come only from the live daemon, so after
  a reload an offline device shows nothing. The `recent-threads` tabs keep
  names in localStorage.

## Where scratch lives

**Recommended: a seeded Scratch project plus a folder per thread.**

- The daemon seeds a second special project next to home: `is_scratch`, name
  "Scratch", path `<data>/scratch`. That's
  `~/.local/share/everywhere/scratch` on Linux, and under
  `%LOCALAPPDATA%\everywhere` on Windows. The project can't be renamed or
  deleted, like home.
- Each thread in it gets its own folder, made when the thread is created:
  `<data>/scratch/2026-10-06-wifi-drops-a1b2/` (date + slug + short id). Claude
  threads, terminal threads and tabs all run there. This is a third workspace
  mode, `scratch`, next to `local | worktree`, reusing the
  `workspace.path` / `threads.workdir` plumbing.
- **No automatic deletion:**
  - Archiving keeps the folder.
  - Deleting a thread asks, the way worktrees do now, but the checkbox is
    **off** by default: "Also delete its scratch folder (N files)".
  - Deleting the Scratch project isn't possible.
  - Uninstall `--purge` already wipes `<data>`, so it should warn when
    scratch has files.

Alternatives considered:

| Option | For | Against |
|---|---|---|
| **One shared scratch folder** | simplest; files from earlier tasks are at hand | piles up fast; two sessions collide; you can't tell which session made what; promotion is messy |
| **Per-thread folders** (recommended) | tidy; a session and its files go together; promotion can keep the same cwd (below) | more folders; a later task can't see earlier files unless pointed to them |
| **Use home (`$HOME`)** | no new concept | litters `~`; no "Everywhere-owned" boundary; writes anywhere look normal |

The scratch folder is only where files land. Claude can still read the whole
machine (`journalctl`, `df`, `~/.config`, …), which diagnosis needs. Scratch
threads default to Auto, which doesn't stop for each edit outside the folder.
So the folder boundary is what the change trail (below) uses to tell "files
for this task" apart from "changes to the machine". Switching a thread to Ask
makes those outside edits prompt.

## Three flows

### A. Scratch in the sidebar only

Each device gets a **Scratch** row pinned above Projects, with its threads
underneath and "New scratch thread" as the main + action.

```
Scratch
 ▾ 🖥 laptop  ●            +
     ✦ Wi-Fi drops after sleep
     ✦ Shrink these PDFs
 ▸ 🖥 hetzner ●
Projects                    ⇅ +
 ▸ api           hetzner
```

- **For:** it's small. It's the project tree, plus a special project.
- **Against:** no device facts or permissions shown, nothing to show when the
  device is offline, and the sidebar grows with each device. It's still "find
  the + button".

### B. A device page with Scratch up front (recommended)

`/d/$deviceId` becomes the device's page, with a Scratch composer at the top.
Clicking a device anywhere (a footer row, a Scratch row, the cards on `/`)
opens it.

```
┌ laptop ● online · Arch/Hyprland · v0.31 · runs as conner ───────────┐
│ ┌───────────────────────────────────────────────────────────────┐ │
│ │ Start a scratch thread on laptop…                             │ │
│ │                                       [Claude ▾]  [Start]     │ │
│ └───────────────────────────────────────────────────────────────┘ │
│  Try: Why is it slow · Disk space · Wi-Fi/Bluetooth · What crashed │
│                                                                    │
│ Claude can:  ✓ run commands as conner   ✗ sudo                    │
│              ◐ see/control screen (desktop on)  [change]           │
│                                                                    │
│ Scratch threads                                 [search] [archived]│
│  ✦ Wi-Fi drops after sleep        idle · 2h   ⚙ 1   📁 3 files     │
│  ✦ Shrink these PDFs              done · 3d         📁 12 files    │
│  ▢ terminal                       —                                │
│                                                                    │
│ Projects on laptop: api · dotfiles · + New project                 │
│ Quick: [Terminal in ~] [Remote desktop] [Browse scratch folder]    │
└────────────────────────────────────────────────────────────────────┘
```

- **Choosing a device:** the footer device rows link here, and `/` shows one
  card per device ("Open laptop") instead of "Pick a thread".
- **Starting work:** type and press Start. That creates a scratch claude
  thread, sends the text and opens it. A terminal is one click away.
  Suggestion chips fill in a starter prompt.
- **Previous sessions:** listed newest first, with status, running processes
  and file count. Claude's first-prompt rename makes the list read like a log
  of tasks. Search uses the existing `threads.search`. Archived threads sit
  behind a toggle.
- **For:** "go to my laptop" is the natural mental model, and the page has
  room for device facts, permissions and offline state. The device's projects
  are listed too, so it's also a way into them.
- **Against:** a new page to build, and a decision about whether scratch also
  appears in the sidebar (recommended: yes, as in A, a compact recent list).

### C. A global "New scratch thread" launcher

`/` (and maybe ⌘K) becomes "What do you need done?" with a device chip,
defaulting to the device you're browsing from if it's enrolled, or the device
used last. Start always goes to Scratch, never guessing at projects.

- **For:** fastest from a phone, needs no navigation, and later extends to
  work across devices (IDEAS.md #3).
- **Against:** the device is easy to miss, and history isn't per-device.
  Better as a shortcut on top of B.

## Recommendation

Build **B** on the **Scratch project with a folder per thread**. Keep A's
sidebar rows as a compact shortcut, and add C later as a composer on `/` that
creates the same thread.

The data model stays small: a scratch thread is an ordinary claude or
terminal thread whose project has `is_scratch`, with workspace mode `scratch`.
`threads.*`, archive, push notifications, processes, tabs and MCP all keep
working. MCP `create_thread` gains `project: "scratch"` and, with no
project given, defaults to Scratch instead of home.

### How a scratch thread differs from a project thread

| | Project thread | Scratch thread |
|---|---|---|
| cwd | project dir, or a worktree | `<data>/scratch/<thread-folder>` |
| Workspace picker / git chip | shown | hidden |
| Starter context | none | appended by the daemon: device name, OS/distro, desktop on/off, where the scratch folder is, "diagnose read-only first, say before changing system state, you can't sudo" |
| Default permission mode | user's default (Auto) | Auto |
| Header | project · device | "laptop · Scratch" + 📁 opens the folder |
| Default tabs | — | Files on the scratch folder once it has files; processes, terminal, desktop as now |

The daemon should add the starter context when it starts claude for a
scratch thread, so threads made over MCP get it too.

### Promoting scratch to a project

Claude Code keeps sessions per working directory, so a session normally
can't change directory. Per-thread folders open a cheap path:

1. **"Make this a project"** registers the thread's scratch folder *as* a
   project (`projects.create` with that path) and moves the thread there. The
   cwd stays the same, so `--resume` still works and the conversation carries
   on. The folder stays under `<data>/scratch` until the user moves it.
2. **"Move to…"** a real location such as `~/code/pdf-tools`, or **"Continue
   in an existing project"**: the cwd changes, so this starts a new thread
   there. Its first prompt is a recap (reuse `auto-recap`) and lists the
   files that were copied, and the scratch thread gets a "Continued in …"
   link back. The scratch folder is kept (no automatic deletion).

Going the other way, a project thread that turns out to be a machine problem
gets "Continue in Scratch", which also starts a new thread with a recap.

### Offline devices

- The device page still loads, with last seen and the `everywhere status`
  hint (what `ConnectionPanel` shows now). It doesn't cache the thread list in
  the browser, so the list appears when the device reconnects.
- No new threads and no queued prompts. Prompts never go through the Worker,
  by design.
- In v1 the offline page only hints that you can diagnose from another
  device: open a sibling's device page and start a scratch thread there.
  A one-click "Diagnose from another device", which would pre-fill a note
  like "the target is laptop (offline since 14:02)", can come later.

### Visibility and permissions

- The page and the thread header say what claude can do, from facts the
  daemon already knows (`device.info`, `desktop.info`): runs as `<user>`, no
  root, screen control on or off.
- **sudo:** claude can't sudo, since the daemon is a user service. Flow:
  claude proposes the command, and "Run in terminal" opens a terminal tab
  with it typed in but not run. The user types their password, so root
  actions stay in human hands and on screen.
- **Desktop control:** stays as it is today. Once a device has run
  `everywhere desktop enable`, every claude thread there (scratch included)
  gets the desktop tools without a per-thread toggle. The page and thread
  header just show that screen control is on.
- **Change trail:** a "Changes" filter in the timeline listing writes outside
  the scratch folder and system-mutating commands (`systemctl`, package
  managers, `rm`). Computed client-side from the event log, it answers "what
  did it do to my laptop?"
- **Storage visibility:** the page shows the scratch folder's total size, and
  each thread its file count, so nothing grows silently even without
  automatic deletion.

## Preserving project workflows

- Projects, + menus, worktrees, `/d/$id/t/$tid`, and MCP project tools:
  unchanged.
- Home leaves the Projects list. Scratch takes over its "general" role, and
  the device page gets a "Terminal in ~" quick action. The home project row
  stays in the daemon, so existing home threads keep working. They're listed
  on the device page (for example under "Home terminals"), and MCP's
  `project_id` for home still resolves.

## Decisions (Conner, 2026-10-07)

1. **Folder location:** hidden, at `<data>/scratch`.
2. **One folder per thread:** yes.
3. **Default permission mode:** Auto.
4. **MCP default:** `create_thread` with no project goes to Scratch.
5. **Home:** drops out of the Projects list. Its threads move to the device
   page, and "Terminal in ~" becomes a quick action there.
6. **Desktop tools:** no per-thread opt-in; they stay as they are today.
7. **Offline cache:** none. The offline page shows last seen and a hint.
8. **Diagnose from another device:** only a hint in v1.
9. **Naming:** "Scratch" for the mode; the device's name is the page title.

10. **Reusing folders:** no. Every new scratch thread gets a fresh folder.
    To use an earlier thread's files, point Claude at that folder's path.

## A possible first slice

1. Daemon: seed the Scratch project; add workspace mode `scratch` (a folder per
   thread, made on create, kept on delete unless asked); append device
   context for scratch claude threads; default scratch claude threads to
   Auto; add a `scratch` feature flag.
2. Worker: MCP `create_thread` defaults to Scratch.
3. Web: make `/d/$deviceId` the device page, titled with the device name
   (Scratch composer, scratch thread list, home terminals, projects, quick
   actions including "Terminal in ~"). Link the footer device rows to it,
   take home out of the Projects list, point `/`'s empty state at device
   cards, and give the offline state its hint.
4. Later: Scratch rows in the sidebar, promote to project, the change trail,
   the launcher on `/`, one-click diagnose from another device.
