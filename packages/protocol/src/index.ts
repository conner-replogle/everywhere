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

export interface Thread {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number | null;
  running: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: string[];
}

/** Control-channel RPC methods: name -> [params, result]. */
export interface RpcMethods {
  "device.info": [Record<string, never>, DeviceInfo];
  "projects.list": [Record<string, never>, Project[]];
  "projects.create": [{ path: string; name?: string }, Project];
  "projects.rename": [{ id: string; name: string }, Project];
  "projects.delete": [{ id: string }, Record<string, never>];
  "threads.list": [{ projectId?: string }, Thread[]];
  "threads.create": [{ projectId: string; name?: string }, Thread];
  "threads.rename": [{ id: string; name: string }, Thread];
  "threads.delete": [{ id: string }, Record<string, never>];
  "fs.listDirs": [{ path: string }, DirListing];
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
