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
 */
export type ClientToHub =
  | { t: "signal"; to: string; sid: string; data: SignalData }
  | { t: "viewing"; deviceId: string; threadId: string }
  | { t: "viewing"; deviceId: null; threadId: null };

/** Sent by the hub to a browser. `from` is a device id. */
export type HubToClient =
  | { t: "presence"; online: string[] }
  | { t: "presence.update"; deviceId: string; online: boolean }
  | { t: "signal"; from: string; sid: string; data: SignalData }
  | { t: "error"; code: HubErrorCode; message: string; sid?: string };

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
 * tabs: tabs.*, threads.workdir, fs.list and file channels.
 */
export type DeviceFeature = "claude" | "update" | "worktrees" | "attachments" | "history" | "archive" | "tabs";

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  /** Why this daemon can't update itself (e.g. a dev build). */
  reason?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  isHome: boolean;
  createdAt: number;
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
export type TabKind = ThreadKind | "browser" | "files";

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
  "threads.list": [{ projectId?: string }, Thread[]];
  "threads.create": [{ projectId: string; name?: string; kind?: ThreadKind }, Thread];
  "threads.rename": [{ id: string; name: string }, Thread];
  /** archive: archiving stops the thread's shell or claude; history and worktree stay. */
  "threads.archive": [{ id: string; archived: boolean }, Thread];
  /** keepWorktree: leave a claude thread's worktree on disk (its branch is always kept). */
  "threads.delete": [{ id: string; keepWorktree?: boolean }, Record<string, never>];
  "threads.workdir": [{ id: string }, Workdir];
  "tabs.list": [{ threadId: string }, Tab[]];
  "tabs.create": [{ threadId: string; kind: TabKind; name?: string }, Tab];
  /** Deletes the tab, stopping its shell or claude. Rename one with threads.rename. */
  "tabs.close": [{ id: string }, Record<string, never>];
  "tabs.setState": [{ id: string; state: string }, Record<string, never>];
  "fs.listDirs": [{ path: string }, DirListing];
  "fs.list": [{ path: string }, FsListing];
  "git.info": [{ projectId: string }, GitInfo];
  /** Claude Code's models and account, before any thread has started. */
  "agent.info": [Record<string, never>, AgentInfo];
  "debug.peer": [Record<string, never>, PeerDebug];
}
export type RpcMethod = keyof RpcMethods;

/**
 * What the hub's rpc requests can call on a daemon: the control methods
 * (except debug.peer and device.update), plus reading and driving threads
 * for callers without a WebRTC connection.
 */
export interface RemoteMethods extends Omit<RpcMethods, "debug.peer" | "device.update"> {
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

export type RpcEvent = { event: "projects.changed" } | { event: "threads.changed" };

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
  | { t: "setThinking"; thinking: boolean };

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
        costUsd?: number;
        durationMs?: number;
      }
    | { type: "notice"; text: string }
    /** What a local slash command (e.g. /cost) printed. */
    | { type: "commandOutput"; text: string }
  );
