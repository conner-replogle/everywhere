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

/** Sent by a browser to the hub. `to` is a device id. */
export type ClientToHub = { t: "signal"; to: string; sid: string; data: SignalData };

/** Sent by the hub to a browser. `from` is a device id. */
export type HubToClient =
  | { t: "presence"; online: string[] }
  | { t: "presence.update"; deviceId: string; online: boolean }
  | { t: "signal"; from: string; sid: string; data: SignalData }
  | { t: "error"; code: HubErrorCode; message: string; sid?: string };

/** Sent by a daemon to the hub. `to` is a browser connection id. */
export type DaemonToHub =
  | { t: "hello"; version: string }
  | { t: "signal"; to: string; sid: string; data: SignalData };

/** Sent by the hub to a daemon. `from` is a browser connection id. */
export type HubToDaemon =
  | { t: "signal"; from: string; sid: string; data: SignalData }
  /** The browser connection's session was signed out; close its peers. */
  | { t: "client.revoked"; connId: string }
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

export interface DeviceInfo {
  hostname: string;
  home: string;
  os: string;
  arch: string;
  version: string;
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
  "projects.list": [Record<string, never>, Project[]];
  "projects.create": [{ path: string; name?: string }, Project];
  "projects.rename": [{ id: string; name: string }, Project];
  "projects.delete": [{ id: string }, Record<string, never>];
  "threads.list": [{ projectId?: string }, Thread[]];
  "threads.create": [{ projectId: string; name?: string; kind?: ThreadKind }, Thread];
  "threads.rename": [{ id: string; name: string }, Thread];
  "threads.delete": [{ id: string }, Record<string, never>];
  "fs.listDirs": [{ path: string }, DirListing];
  "debug.peer": [Record<string, never>, PeerDebug];
}
export type RpcMethod = keyof RpcMethods;

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
  | { t: "attach"; afterSeq?: number }
  | { t: "send"; text: string }
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
  | { t: "setModel"; model: string };

export type AgentDaemonMsg =
  | { t: "event"; seq: number; at: number; event: AgentEvent }
  | { t: "synced"; truncated: boolean }
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
}

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
}

interface AgentEventBase {
  /** Set on events from a subagent: the id of the tool call that started it. */
  parentId?: string;
}

/** One persisted entry in a claude thread's log. */
export type AgentEvent = AgentEventBase &
  (
    | { type: "user"; id: string; text: string }
    | { type: "assistant" | "thinking"; id: string; text: string; streamKey?: string }
    /** id is the tool_use id; a toolResult with the same id follows. */
    | { type: "tool"; id: string; name: string; input: unknown }
    | { type: "toolResult"; id: string; output: string; isError?: boolean }
    | {
        type: "request";
        id: string;
        kind: AgentRequest["kind"];
        toolName: string;
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
  );
