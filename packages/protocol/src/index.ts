// Wire protocol shared by the Worker, the web app and (mirrored by hand in)
// the Go daemon: daemon/internal/protocol. Keep the two in sync.

// ---------------------------------------------------------------------------
// Hub WebSocket (browser <-> AccountHub DO <-> daemon)
// ---------------------------------------------------------------------------

export interface IceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type SignalData =
  | { type: "offer" | "answer"; sdp: string }
  | { type: "candidate"; candidate: IceCandidate }
  | { type: "bye" };

/**
 * Sent by a browser to the hub. `to` is a device id. `viewing` says which
 * thread the tab shows while it's visible and focused (null otherwise), so the
 * hub doesn't push notifications about a thread someone is looking at.
 * `active` says someone is using the tab and it shows alerts itself, so the
 * hub holds back push notifications altogether.
 */
export type ClientToHub =
  | { t: "signal"; to: string; sid: string; data: SignalData }
  | { t: "viewing"; deviceId: string; threadId: string; active?: boolean }
  | { t: "viewing"; deviceId: null; threadId: null; active?: boolean };

/** Sent by the hub to a browser. `from` is a device id. */
export type HubToClient =
  | { t: "presence"; online: string[] }
  | { t: "presence.update"; deviceId: string; online: boolean }
  | { t: "signal"; from: string; sid: string; data: SignalData }
  | { t: "error"; code: HubErrorCode; message: string; sid?: string }
  /** A daemon's notify, relayed so open tabs can show it in the app. */
  | HubAlert;

/** Sent by a daemon to the hub. `to` is a browser connection id. */
export type DaemonToHub =
  /** features: what the daemon supports over this socket; absent on older daemons. */
  | { t: "hello"; version: string; features?: HubFeature[] }
  | { t: "signal"; to: string; sid: string; data: SignalData }
  /** Answers an rpc request. */
  | { t: "rpc.result"; id: string; result?: unknown; error?: { message: string } }
  /** Something the user should hear about, sent as a push notification. */
  | HubNotify;

/**
 * A claude thread needs the user (a permission prompt, a question, a plan to
 * approve) or finished its turn. `threadId` is the thread or tab it happened
 * in; `parentId` is the tab's thread. Only names travel, never content.
 */
export interface HubNotify {
  t: "notify";
  threadId: string;
  parentId?: string;
  name: string;
  kind: NotifyKind;
  /** For kind "permission": the tool's name. */
  tool?: string;
}

export type NotifyKind = "permission" | "question" | "plan" | "done" | "error";

/** A HubNotify as the hub passes it on to browsers, with the device it came from. */
export interface HubAlert extends Omit<HubNotify, "t"> {
  t: "alert";
  deviceId: string;
}

/** Whether the notify asks the user for something, rather than reporting the turn ended. */
export function notifyNeedsYou(kind: NotifyKind): boolean {
  return kind !== "done" && kind !== "error";
}

/** One line saying what happened, e.g. "Has a question for you". */
export function notifyText(n: Pick<HubNotify, "kind" | "tool">): string {
  switch (n.kind) {
    case "permission":
      return n.tool ? `Wants to use ${n.tool}` : "Needs your permission";
    case "question":
      return "Has a question for you";
    case "plan":
      return "Has a plan for you to review";
    case "done":
      return "Finished";
    case "error":
      return "Stopped with an error";
  }
}

/** rpc: the daemon answers rpc requests (see RemoteMethods). */
export type HubFeature = "rpc";

/** Sent by the hub to a daemon. `from` is a browser connection id. */
export type HubToDaemon =
  | { t: "signal"; from: string; sid: string; data: SignalData }
  /** The browser connection's session was signed out; close its peers. */
  | { t: "client.revoked"; connId: string }
  /** A request from an agent using the account's MCP endpoint; answered with rpc.result. */
  | { t: "rpc"; id: string; method: string; params: unknown }
  | { t: "error"; code: HubErrorCode; message: string };

export type HubErrorCode = "device_offline" | "client_gone" | "daemon_too_old" | "bad_message" | "revoked";

/** Plain-text keepalive handled by the hub's auto-response (never wakes the DO). */
export const HUB_PING = "ping";
export const HUB_PONG = "pong";

// ---------------------------------------------------------------------------
// WebRTC data channels (browser <-> daemon)
// ---------------------------------------------------------------------------

export const CONTROL_CHANNEL = "control";
export const TERM_CHANNEL_PREFIX = "term:";
export const AGENT_CHANNEL_PREFIX = "agent:";
export const UPLOAD_CHANNEL_PREFIX = "upload:";
export const FILE_CHANNEL_PREFIX = "file:";

export * from "./browser";

export interface DeviceInfo {
  hostname: string;
  home: string;
  os: string;
  arch: string;
  version: string;
  /** What the daemon supports beyond V1; absent on daemons older than this field. */
  features?: DeviceFeature[];
}

/**
 * claude: claude threads and the agent channel. update: device.checkUpdate and
 * device.update. worktrees: claude threads in their own git worktree, and
 * git.info. attachments: upload channels and attachments on send. history:
 * the agent attach limit and history paging. archive: threads.archive.
 * tabs: tabs.*, threads.workdir, fs.list and file channels. desktop:
 * desktop.info, desktop.start and desktop.stop (remote desktop). rewind: the
 * agent channel's rewind request. icons: projects.icon. clone: projects.clone,
 * clones.list and clones.changed. gitStatus: git.status, git.fetch, git.pull,
 * git.updateDefault and git.changed. claudeUpdate: agent.claudeVersion and
 * agent.updateClaude.
 */
export type DeviceFeature =
  | "claude"
  | "update"
  | "worktrees"
  | "attachments"
  | "history"
  | "archive"
  | "tabs"
  | "desktop"
  | "rewind"
  | "icons"
  | "clone"
  | "gitStatus"
  | "claudeUpdate";

/**
 * What desktop.start captures: a monitor by name, or a window by id
 * (Hyprland's stableId). class and title find a desktop tab's window again
 * after its app restarted. Empty: the focused monitor.
 */
export interface DesktopSource {
  output?: string;
  window?: string;
  class?: string;
  title?: string;
}

/** desktop.info: whether remote desktop can be used on the device right now. */
export interface DesktopInfo {
  /** The device owner turned it on (`everywhere desktop enable`, run on the device). */
  enabled: boolean;
  /** The worker is installed and a Hyprland session is running; `reason` says why not. */
  available: boolean;
  reason?: string;
  /** Who is connected, if anyone. */
  viewer?: string;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  /** Why this daemon can't update itself (e.g. a dev build). */
  reason?: string;
}

/** agent.claudeVersion: the device's Claude Code and the newest release. */
export interface ClaudeVersion {
  current: string;
  latest: string;
  available: boolean;
  /** The claude executable. */
  path: string;
  /** agent.updateClaude runs `command`, the update of the installer that owns this install. */
  canUpdate: boolean;
  command?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  isHome: boolean;
  createdAt: number;
}

/** A clone into a new project (projects.clone). */
export interface CloneStatus {
  projectId: string;
  /** Without credentials. */
  url: string;
  path: string;
  phase: "running" | "done" | "failed";
  stage: "connecting" | "counting" | "receiving" | "resolving" | "checkout";
  /** Of the stage; -1 if unknown. */
  percent: number;
  /** e.g. "12.30 MiB | 5.00 MiB/s" */
  detail?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/** An image file from a project, for a data: URL. */
export interface ProjectIcon {
  mime: string;
  /** The file, base64. */
  data: string;
  /** Changes when the file does. */
  rev: string;
}

export type ThreadKind = "terminal" | "claude";

/**
 * A claude thread's status:
 * - stopped: no claude process; the next message resumes the conversation
 * - starting: launching claude
 * - idle: claude is running, no turn in progress
 * - working: a turn is in progress
 * - waiting: a turn is blocked on the user (a permission prompt or question)
 * - error: claude failed to start or crashed; see AgentState.error
 */
export type AgentStatus = "stopped" | "starting" | "idle" | "working" | "waiting" | "error";

export interface Thread {
  id: string;
  projectId: string;
  kind: ThreadKind;
  name: string;
  createdAt: number;
  lastOpenedAt: number | null;
  /** A live shell (terminal) or claude process (claude). */
  running: boolean;
  /** Set for claude threads; see AgentState.status. */
  agentStatus?: AgentStatus;
  /** The git worktree a claude thread runs in, once created. */
  worktree?: string;
  /** archive: set while archived (hidden, its shell or claude stopped). */
  archivedAt?: number;
}

/** What a tab shows: a thread kind, the project's browser, or its files. */
export type TabKind = ThreadKind | "browser" | "files" | "desktop";

/**
 * A tab opened inside a thread. Terminal and claude tabs are threads of
 * their own, run where their thread runs (its worktree, if it has one).
 */
export interface Tab extends Omit<Thread, "kind" | "archivedAt"> {
  kind: TabKind;
  /** The thread the tab belongs to. */
  parentId: string;
  /** The tab's UI state, as its view saved it (tabs.setState). */
  tabState?: string;
}

/** Where a thread works (threads.workdir). */
export interface Workdir {
  path: string;
  /** path is a git worktree (the thread's, or the one of the thread it's a tab of). */
  worktree: boolean;
}

export interface FsEntry {
  name: string;
  dir: boolean;
  size: number;
  /** Unix ms. */
  modTime: number;
}

export interface FsListing {
  path: string;
  parent: string | null;
  /** Directories first, then files, by name. */
  entries: FsEntry[];
}

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: string[];
}

export interface CandidateInfo {
  type: string; // host | srflx | prflx | relay
  protocol: string; // udp | tcp
  address: string;
  port: number;
}

/** The daemon's view of one browser's peer connection, for the debug panel. */
export interface PeerDebug {
  sid: string;
  connectionState: string;
  iceConnectionState: string;
  selectedPair: { local: CandidateInfo; remote: CandidateInfo } | null;
  localCandidates: CandidateInfo[];
  remoteCandidates: CandidateInfo[];
  /** Network interfaces the daemon gathers candidates on, e.g. tailscale0 100.101.102.103. */
  interfaces: { name: string; addresses: string[] }[];
  openTerminals: number;
  connectedForMs: number;
}

/** Control-channel RPC methods: name -> [params, result]. */
export interface RpcMethods {
  "device.info": [Record<string, never>, DeviceInfo];
  /** force: skip the daemon's short-lived cache of the latest release. */
  "device.checkUpdate": [{ force?: boolean }, UpdateInfo];
  /** Installs the latest release, answers, then restarts into it (the connection drops). */
  "device.update": [Record<string, never>, { version: string }];
  "projects.list": [Record<string, never>, Project[]];
  "projects.create": [{ path: string; name?: string }, Project];
  "projects.rename": [{ id: string; name: string }, Project];
  "projects.delete": [{ id: string }, Record<string, never>];
  /**
   * Creates a project at path (missing or an empty folder) and clones url
   * into it in the background, with the device's own git credentials;
   * clones.list follows it. The Worker relays GitHub clones with a token.
   */
  "projects.clone": [{ url: string; path: string; name?: string }, Project];
  /** Clones running, just finished, or failed (until their project is deleted). */
  "clones.list": [Record<string, never>, CloneStatus[]];
  /** The project's favicon or logo, found in its files; null if it has none. */
  "projects.icon": [{ id: string }, { icon: ProjectIcon | null }];
  "threads.list": [{ projectId?: string }, Thread[]];
  /** permissionMode: a claude thread's starting mode (older daemons ignore it). */
  "threads.create": [{ projectId: string; name?: string; kind?: ThreadKind; permissionMode?: PermissionMode }, Thread];
  "threads.rename": [{ id: string; name: string }, Thread];
  /** archive: archiving stops the thread's shell or claude; history and worktree stay. */
  "threads.archive": [{ id: string; archived: boolean }, Thread];
  /** keepWorktree: leave a claude thread's worktree on disk (its branch is always kept). */
  "threads.delete": [{ id: string; keepWorktree?: boolean }, Record<string, never>];
  "threads.workdir": [{ id: string }, Workdir];
  "tabs.list": [{ threadId: string }, Tab[]];
  "tabs.create": [{ threadId: string; kind: TabKind; name?: string; permissionMode?: PermissionMode }, Tab];
  /** Deletes the tab, stopping its shell or claude. Rename one with threads.rename. */
  "tabs.close": [{ id: string }, Record<string, never>];
  "tabs.setState": [{ id: string; state: string }, Record<string, never>];
  "fs.listDirs": [{ path: string }, DirListing];
  "fs.list": [{ path: string }, FsListing];
  "git.info": [{ projectId: string }, GitInfo];
  /**
   * Where a thread's checkout (its worktree, if any) or a project's stands.
   * Reading it keeps origin fetched in the background, about once a minute;
   * git.changed says when to read it again.
   */
  "git.status": [{ threadId?: string; projectId?: string }, GitStatus];
  "git.fetch": [{ threadId?: string; projectId?: string }, GitStatus];
  /** Fast-forwards the current branch to its upstream. */
  "git.pull": [{ threadId?: string; projectId?: string }, GitStatus];
  /** Fast-forwards the local default branch (e.g. main) to origin's. */
  "git.updateDefault": [{ threadId?: string; projectId?: string }, GitStatus];
  /** Claude Code's models and account, before any thread has started. */
  "agent.info": [Record<string, never>, AgentInfo];
  /** force: skip the daemon's hour-long cache of the newest release. */
  "agent.claudeVersion": [{ force?: boolean }, ClaudeVersion];
  /**
   * Runs the update of the installer that owns claude (see ClaudeVersion).
   * Open threads move to the new version when they're next idle.
   */
  "agent.updateClaude": [Record<string, never>, { version: string }];
  "debug.peer": [Record<string, never>, PeerDebug];
  "desktop.info": [Record<string, never>, DesktopInfo];
  /**
   * Starts a remote desktop session on its own PeerConnection: sdp is its
   * offer (one recvonly video transceiver, data channels "input" and
   * "control"); the result carries the answer. A new session takes over from
   * the current one. mode: sharp | smooth | low; viewer names this browser;
   * source picks what to capture; tabId is the desktop tab showing it, so
   * closing the tab ends it.
   */
  "desktop.start": [
    { sdp: string; mode: string; viewer: string; source?: DesktopSource; tabId?: string },
    { id: string; sdp: string },
  ];
  /**
   * Trickle ICE: the browser's candidates go to the daemon with this; the
   * daemon's arrive as desktop.candidate events, possibly before
   * desktop.start answers.
   */
  "desktop.candidate": [{ id: string; candidate: IceCandidate }, Record<string, never>];
  "desktop.stop": [{ id: string }, Record<string, never>];
}
export type RpcMethod = keyof RpcMethods;

/**
 * What the hub's rpc requests can call on a daemon: the control methods
 * (except debug.peer and device.update), plus reading and driving threads
 * for callers without a WebRTC connection.
 */
export interface RemoteMethods
  extends Omit<RpcMethods, "debug.peer" | "device.update" | `desktop.${string}`> {
  // Coding tools for MCP agents. Relative paths (and cwd) are resolved against
  // the thread's working directory (its worktree, if any), else the project,
  // else home.
  /** Runs a command with bash -c and the user's login environment. */
  "code.exec": [CodeWhere & { command: string; stdin?: string; timeoutMs?: number }, CodeExecResult];
  /** offset: first line (1-based); limit: lines (default 2000). */
  "code.read": [CodeWhere & { path: string; offset?: number; limit?: number }, CodeReadResult];
  "code.write": [CodeWhere & { path: string; content: string }, { path: string; bytes: number; created: boolean }];
  /** Replaces old with new: exactly one occurrence, or all of them. */
  "code.edit": [CodeWhere & { path: string; old: string; new: string; all?: boolean }, { path: string; replacements: number }];
  /** Files matching pattern under path, newest first; follows .gitignore in a repo. */
  "code.glob": [CodeWhere & { pattern?: string; limit?: number }, { dir: string; files: string[]; truncated?: boolean }];
  "code.grep": [
    CodeWhere & { pattern: string; glob?: string; ignoreCase?: boolean; filesOnly?: boolean; context?: number; limit?: number },
    { dir: string; output: string; count: number; truncated?: boolean },
  ];
  /** projects.clone, with a token answering git's HTTPS credential prompt. */
  "projects.clone": [{ url: string; path: string; name?: string; token?: string }, Project];
  "threads.get": [{ threadId: string }, Thread];
  /** Threads whose name or claude prompts and replies contain query, newest match first. */
  "threads.search": [{ query: string; limit?: number }, SearchHit[]];
  /**
   * A claude thread's state and the newest limit events after afterSeq (and
   * before beforeSeq). waitMs: first wait up to that long (at most 50s) for
   * a turn in progress to finish or block on a prompt.
   */
  "agent.read": [
    { threadId: string; afterSeq?: number; beforeSeq?: number; limit?: number; waitMs?: number },
    AgentRead,
  ];
  /** Any agent channel request but attach and history. */
  "agent.request": [{ threadId: string; msg: AgentClientMsg }, Record<string, never>];
  /** The end of a terminal's scrollback as plain text. */
  "term.read": [{ threadId: string; maxBytes?: number }, TermRead];
  /** Types into a terminal thread, starting its shell if needed. */
  "term.write": [{ threadId: string; text: string }, Record<string, never>];
}
export type RemoteMethod = keyof RemoteMethods;

/** Where a code.* request is rooted, and the path it's about. */
export interface CodeWhere {
  threadId?: string;
  projectId?: string;
  /** A directory to resolve relative paths against instead. */
  cwd?: string;
  path?: string;
}

export interface CodeExecResult {
  /** -1 if it didn't exit on its own. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Bytes dropped from the start of the stream (the end is kept). */
  stdoutCut?: number;
  stderrCut?: number;
  timedOut?: boolean;
  durationMs: number;
  cwd: string;
}

export interface CodeReadResult {
  path: string;
  /** Each line prefixed with its number and a tab. */
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated?: boolean;
}

export interface SearchHit {
  threadId: string;
  /** Around the newest matching message; absent when only the name matched. */
  snippet?: string;
  at: number;
}

export interface AgentRead {
  thread: Thread;
  /** Without models and commands. */
  state: AgentState;
  events: { seq: number; at: number; event: AgentEvent }[];
  /** There are older events before these. */
  more: boolean;
  /** The newest event's seq (0 if none). */
  lastSeq: number;
}

export interface TermRead {
  thread: Thread;
  output: string;
  truncated: boolean;
}

export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  id: number;
  method: M;
  params: RpcMethods[M][0];
}

export type RpcResponse =
  | { id: number; result: unknown }
  | { id: number; error: { message: string } };

export type RpcEvent =
  | { event: "projects.changed" }
  | { event: "clones.changed" }
  | { event: "git.changed" }
  | { event: "threads.changed" }
  /** One of a desktop session's ICE candidates (trickle ICE); see desktop.start. */
  | { event: "desktop.candidate"; id: string; candidate: IceCandidate };

/**
 * File channel `file:<id>`, one per read. The client sends `read`; the daemon
 * answers `start`, the file as binary chunks, then `end`, or `error` at any
 * point. Files over 25 MB are refused.
 */
export type FileClientMsg = { t: "read"; path: string };

export type FileDaemonMsg =
  | { t: "start"; path: string; size: number; modTime: number }
  | { t: "end" }
  | { t: "error"; message: string };

/**
 * Terminal channel `term:<threadId>`. Binary messages are raw PTY bytes in
 * both directions; string messages are JSON control frames below. The client
 * must send `attach` first; the daemon spawns the shell if it isn't running,
 * replays scrollback, then reports writer status.
 */
export type TermClientMsg =
  | { t: "attach"; cols: number; rows: number }
  | { t: "resize"; cols: number; rows: number }
  | { t: "takeover"; cols: number; rows: number };

export type TermDaemonMsg =
  | { t: "writer"; you: boolean }
  | { t: "exited"; code: number }
  | { t: "error"; message: string };

/**
 * Agent channel `agent:<threadId>` for claude threads: JSON text frames both
 * ways. The client sends `attach` first; the daemon replays persisted events
 * after `afterSeq`, sends `synced`, then the live state and every change.
 */
export type AgentClientMsg =
  /** limit (history): replay only the newest this many; the default is the most the daemon sends. */
  | { t: "attach"; afterSeq?: number; limit?: number }
  /** history: the page of events before beforeSeq, answered with a history frame. */
  | { t: "history"; beforeSeq: number; limit?: number }
  /** attachments: ids of finished uploads. */
  | { t: "send"; text: string; attachments?: string[] }
  | { t: "interrupt" }
  | {
      t: "respond";
      requestId: string;
      decision: "allow" | "allowSession" | "deny";
      /** deny: feedback for claude. */
      message?: string;
      /** question requests: question text -> chosen answer. */
      answers?: Record<string, string>;
    }
  | { t: "setMode"; mode: PermissionMode }
  /** "" means claude's default model. */
  | { t: "setModel"; model: string }
  /** Before the first prompt only. baseBranch "" means the current branch. */
  | { t: "setWorkspace"; workspace: "local" | "worktree"; baseBranch?: string }
  /** "" means the model's default effort. */
  | { t: "setEffort"; effort: EffortLevel | "" }
  | { t: "setThinking"; thinking: boolean }
  /**
   * Rolls the conversation back to before the prompt with event id `id`,
   * forking claude's session there. files: also undo claude's file edits since
   * (only edits made through its edit tools, not by shell commands).
   */
  | { t: "rewind"; id: string; files?: boolean };

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type AgentDaemonMsg =
  | { t: "event"; seq: number; at: number; event: AgentEvent }
  /** truncated: there are older events than the ones replayed. */
  | { t: "synced"; truncated: boolean }
  /** Answers history: events oldest first; more when there are older ones still. */
  | { t: "history"; events: { seq: number; at: number; event: AgentEvent }[]; more: boolean }
  | { t: "state"; state: AgentState }
  /** Appends to state.streaming[key]; not persisted. */
  | { t: "delta"; key: string; kind: "text" | "thinking"; text: string }
  | { t: "error"; message: string };

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";

export interface AgentState {
  status: AgentStatus;
  error?: string;
  sessionId?: string;
  /** Configured model; "" means claude's default. */
  model: string;
  /** The model the running session actually uses. */
  activeModel?: string;
  permissionMode: PermissionMode;
  pending: AgentRequest[];
  streaming: AgentStreaming[];
  models: AgentModel[];
  account?: { email?: string; subscriptionType?: string };
  /** Claude's latest rate_limit_info, passed through. */
  rateLimit?: unknown;
  workspace: AgentWorkspace;
  /** How full the context window is, when known. */
  context?: AgentContext;
  /** Configured effort; "" means the model's default. Absent on older daemons. */
  effort?: EffortLevel | "";
  /** Whether extended thinking is on. Absent on older daemons. */
  thinking?: boolean;
  /** Slash commands a prompt can start with. Absent on older daemons. */
  commands?: AgentCommand[];
  /** Claude's guess at the next prompt, until one is sent. */
  suggestion?: string;
  /** The plan's usage windows, when known. */
  limits?: AgentLimit[];
  /** Claude is summarizing the conversation to free context. */
  compacting?: boolean;
  /** The turn in progress is only a /recap (the thread shows idle elsewhere). */
  recapping?: boolean;
  /** The Claude Code version the thread's claude runs, or would start with. */
  claudeVersion?: string;
}

export interface AgentCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/** One rate-limit window of the claude.ai plan. */
export interface AgentLimit {
  /** five_hour | seven_day | seven_day_opus | ... */
  window: string;
  /** Fraction of the window used, 0-1. */
  used: number;
  /** Unix ms; 0 if unknown. */
  resetsAt: number;
}

export interface AgentWorkspace {
  mode: "local" | "worktree";
  baseBranch?: string;
  /** The worktree, once created. */
  path?: string;
  branch?: string;
  /** The thread has started, so the workspace is fixed. */
  locked: boolean;
}

export interface AgentContext {
  used: number;
  max: number;
  percentage: number;
  /** When it was measured (Unix ms): the conversation's last use. */
  updatedAt?: number;
}

export interface AgentAttachment {
  id: string;
  name: string;
  kind: "image" | "file";
  mediaType: string;
  size: number;
}

export interface AgentInfo {
  available: boolean;
  /** Why claude isn't usable here. */
  error?: string;
  models: AgentModel[];
  account?: { email?: string; subscriptionType?: string };
  commands?: AgentCommand[];
  limits?: AgentLimit[];
}

export interface GitStatus {
  isRepo: boolean;
  /** "" when detached; head says where. */
  branch: string;
  /** Short commit; "" before the first commit. */
  head: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  /** Lines added and removed against HEAD in tracked files. */
  insertions: number;
  deletions: number;
  /** A linked worktree, not the repo's main checkout. */
  worktree: boolean;
  root: string;
  /** origin's default branch, e.g. "main". */
  defaultBranch?: string;
  /** Commits origin's default branch has that the local one lacks; -1 without a local copy. */
  defaultBehind: number;
  /** HEAD against origin's default branch, when not on it. */
  aheadOfDefault: number;
  behindDefault: number;
  /** When origin was last fetched (Unix ms). */
  fetchedAt?: number;
  fetchError?: string;
  fetching?: boolean;
}

export interface GitInfo {
  isRepo: boolean;
  /** The checked-out branch; "" when detached. */
  current: string;
  branches: string[];
}

/**
 * Upload channel `upload:<id>` (id: 8-64 of [a-z0-9]), one per file. The client
 * sends UploadStart, the file as binary chunks, then {t:"end"}; the daemon
 * answers with UploadResult and the client closes the channel.
 */
export type UploadStart = { t: "start"; threadId: string; name: string; mediaType: string; size: number };
export type UploadResult = { t: "done"; attachment: AgentAttachment } | { t: "error"; message: string };

/** A prompt waiting for the user. */
export interface AgentRequest {
  id: string;
  kind: "tool" | "question" | "plan";
  toolName: string;
  toolUseId: string;
  input: unknown;
  title?: string;
  description?: string;
  decisionReason?: string;
  /** Whether "allow for this session" is offered. */
  canAllowSession: boolean;
}

export interface AgentStreaming {
  key: string;
  kind: "text" | "thinking";
  text: string;
}

export interface AgentModel {
  value: string;
  displayName: string;
  description?: string;
  /** The model id an alias (like default) stands for now. Absent on older daemons. */
  resolvedModel?: string;
  /** Effort levels the model accepts; absent when it has no effort control. */
  effortLevels?: EffortLevel[];
  /** Whether the model can think. */
  thinking?: boolean;
}

interface AgentEventBase {
  /** Set on events from a subagent: the id of the tool call that started it. */
  parentId?: string;
}

/** One persisted entry in a claude thread's log. */
export type AgentEvent = AgentEventBase &
  (
    | { type: "user"; id: string; text: string; attachments?: AgentAttachment[] }
    | { type: "assistant" | "thinking"; id: string; text: string; streamKey?: string }
    /** id is the tool_use id; a toolResult with the same id follows. */
    | { type: "tool"; id: string; name: string; input: unknown }
    | { type: "toolResult"; id: string; output: string; isError?: boolean }
    | {
        type: "request";
        id: string;
        kind: AgentRequest["kind"];
        toolName: string;
        /** The tool call this prompt was about. */
        toolUseId: string;
        decision: "allow" | "allowSession" | "deny" | "canceled";
        answers?: Record<string, string>;
        text?: string;
      }
    | {
        type: "turn";
        status: "started" | "completed" | "interrupted" | "error";
        text?: string;
        /** contextFull: an error because the conversation outgrew the context window. */
        kind?: "contextFull";
        costUsd?: number;
        durationMs?: number;
      }
    /** kind compact: the conversation was compacted. */
    | { type: "notice"; text: string; kind?: "compact" }
    /**
     * The conversation was rolled back to before prompt `id` (whose text is
     * `text`): events from fromSeq up to this one were removed.
     */
    | { type: "rewind"; id: string; text: string; fromSeq: number; filesRestored?: number }
    /** What a local slash command (e.g. /cost) printed. */
    | { type: "commandOutput"; text: string }
  );
