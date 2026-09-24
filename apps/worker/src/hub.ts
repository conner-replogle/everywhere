import { DurableObject } from "cloudflare:workers";
import type {
  ClientToHub,
  DaemonToHub,
  HubErrorCode,
  HubFeature,
  HubToClient,
  HubToDaemon,
  RemoteMethod,
  RemoteMethods,
} from "@everywhere/protocol";
import { HUB_PING, HUB_PONG } from "@everywhere/protocol";
import { randomId } from "./crypto";
import { versionAtLeast } from "./version";

type Attachment =
  | { kind: "device"; id: string; since?: number; features?: HubFeature[] }
  | { kind: "client"; id: string; session: string };

/** How a relayed rpc request ended. */
export type DeviceRpcResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; code: "offline" | "unsupported" | "timeout" | "error"; message: string };

interface PendingRpc {
  deviceId: string;
  resolve: (r: DeviceRpcResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Daemons ping every 15s (25s in older versions). A daemon whose network went away
// leaves its socket open here with nothing coming through, so one that hasn't
// pinged in this long counts as offline and is closed.
const DEVICE_SILENT_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;

export const HUB_KIND_HEADER = "x-ew-kind";
export const HUB_ID_HEADER = "x-ew-id";
export const HUB_SESSION_HEADER = "x-ew-session";

/**
 * One per account. Holds a hibernatable WebSocket for every connected daemon
 * and browser tab, relays WebRTC signaling between them, and broadcasts device
 * presence. It never sees browsers' terminal data; the only project and thread
 * data through it is rpc for agents using the MCP endpoint.
 */
export class AccountHub extends DurableObject<Env> {
  /** rpc requests waiting on a daemon. In memory: the caller's request keeps the DO awake. */
  private pending = new Map<string, PendingRpc>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HUB_PING, HUB_PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    const kind = request.headers.get(HUB_KIND_HEADER);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    if (kind === "device") {
      const deviceId = request.headers.get(HUB_ID_HEADER);
      if (!deviceId) return new Response("missing device id", { status: 400 });
      // A daemon reconnecting replaces its stale socket.
      for (const ws of this.ctx.getWebSockets(`device:${deviceId}`)) ws.close(4000, "replaced");
      this.ctx.acceptWebSocket(server, [`device:${deviceId}`]);
      server.serializeAttachment({ kind: "device", id: deviceId, since: Date.now() } satisfies Attachment);
      this.broadcast({ t: "presence.update", deviceId, online: true });
      await this.touchDevice(deviceId);
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
      }
    } else {
      const connId = randomId();
      this.ctx.acceptWebSocket(server, [`client:${connId}`]);
      const session = request.headers.get(HUB_SESSION_HEADER) ?? "";
      server.serializeAttachment({ kind: "client", id: connId, session } satisfies Attachment);
      send(server, { t: "presence", online: this.onlineDevices() } satisfies HubToClient);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const me = ws.deserializeAttachment() as Attachment;
    let msg: unknown;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.fail(ws, "bad_message", "invalid JSON");
    }

    if (me.kind === "client") {
      const m = msg as ClientToHub;
      if (!isSignal(m)) return this.fail(ws, "bad_message", "unknown message");
      // Re-check the session before each new connection, so sessions removed
      // out of band (expiry, reset-password script) can't open new peers.
      if (m.data.type === "offer") {
        if (!(await this.sessionValid(me.session))) {
          ws.close(4003, "session expired");
          return;
        }
        await this.closeSilentDevices();
      }
      const target = this.socket(`device:${m.to}`);
      if (!target) {
        return send(ws, { t: "error", code: "device_offline", message: "device is offline", sid: m.sid } satisfies HubToClient);
      }
      send(target, { t: "signal", from: me.id, sid: m.sid, data: m.data } satisfies HubToDaemon);
      return;
    }

    const m = msg as DaemonToHub;
    if (m.t === "hello") {
      if (!versionAtLeast(m.version, this.env.MIN_DAEMON_VERSION)) {
        this.fail(ws, "daemon_too_old", `daemon ${m.version} is older than ${this.env.MIN_DAEMON_VERSION}; run \`everywhere update\``);
        ws.close(4001, "daemon_too_old");
        return;
      }
      if (Array.isArray(m.features)) {
        const features = m.features.filter((f): f is HubFeature => f === "rpc");
        ws.serializeAttachment({ ...me, features } satisfies Attachment);
      }
      return;
    }
    if (m.t === "rpc.result") {
      const p = typeof m.id === "string" ? this.pending.get(m.id) : undefined;
      if (!p || p.deviceId !== me.id) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve(
        m.error
          ? { ok: false, code: "error", message: String(m.error.message ?? "failed") }
          : { ok: true, result: m.result },
      );
      return;
    }
    if (isSignal(m)) {
      const target = this.socket(`client:${m.to}`);
      if (!target) return this.fail(ws, "client_gone", `client ${m.to} is gone`);
      send(target, { t: "signal", from: me.id, sid: m.sid, data: m.data } satisfies HubToClient);
      return;
    }
    this.fail(ws, "bad_message", "unknown message");
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.onGone(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.onGone(ws);
  }

  /** Periodic sweep for daemons that went silent, while any are connected. */
  override async alarm(): Promise<void> {
    await this.closeSilentDevices();
    if (this.ctx.getWebSockets().some((ws) => (ws.deserializeAttachment() as Attachment | null)?.kind === "device")) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }

  /** The online devices, and which of them answer rpc requests. */
  async devices(): Promise<{ id: string; rpc: boolean }[]> {
    const out = new Map<string, boolean>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.kind === "device" && this.live(ws)) out.set(a.id, !!a.features?.includes("rpc"));
    }
    return [...out].map(([id, rpc]) => ({ id, rpc }));
  }

  /**
   * Relays a request to a daemon over its socket (for agents using the MCP
   * endpoint, which have no WebRTC connection) and waits for the answer.
   */
  async deviceRpc<M extends RemoteMethod>(
    deviceId: string,
    method: M,
    params: RemoteMethods[M][0],
    timeoutMs = 30_000,
  ): Promise<DeviceRpcResult<RemoteMethods[M][1]>> {
    const ws = this.socket(`device:${deviceId}`);
    if (!ws) return { ok: false, code: "offline", message: "the device is offline" };
    const a = ws.deserializeAttachment() as Attachment;
    if (a.kind !== "device" || !a.features?.includes("rpc")) {
      return { ok: false, code: "unsupported", message: "the device's daemon is too old for this; update it" };
    }
    const id = randomId();
    const result = new Promise<DeviceRpcResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, code: "timeout", message: "the device didn't answer in time" });
      }, timeoutMs);
      this.pending.set(id, { deviceId, resolve, timer });
    });
    send(ws, { t: "rpc", id, method, params } satisfies HubToDaemon);
    return (await result) as DeviceRpcResult<RemoteMethods[M][1]>;
  }

  /** Called by the Worker when a device is revoked. */
  async revokeDevice(deviceId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(`device:${deviceId}`)) {
      this.fail(ws, "revoked", "device was removed");
      ws.close(4003, "revoked");
    }
    this.broadcast({ t: "presence.update", deviceId, online: false });
  }

  /**
   * Called when sessions are signed out or revoked: closes their sockets and
   * tells daemons to drop any WebRTC peers those browsers opened.
   */
  async revokeSessions(sessionIds: string[]): Promise<void> {
    const revoked = new Set(sessionIds);
    const conns: string[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.kind === "client" && revoked.has(a.session)) {
        conns.push(a.id);
        ws.close(4003, "signed out");
      }
    }
    if (conns.length === 0) return;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.kind !== "device") continue;
      for (const connId of conns) send(ws, { t: "client.revoked", connId } satisfies HubToDaemon);
    }
  }

  private async onGone(ws: WebSocket): Promise<void> {
    const me = ws.deserializeAttachment() as Attachment | null;
    if (me?.kind !== "device") return;
    // A replacement socket may already be open for the same device.
    if (this.socket(`device:${me.id}`, ws)) return;
    for (const [id, p] of this.pending) {
      if (p.deviceId !== me.id) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve({ ok: false, code: "offline", message: "the device disconnected" });
    }
    this.broadcast({ t: "presence.update", deviceId: me.id, online: false });
    await this.touchDevice(me.id);
  }

  /** Closes daemon sockets that stopped pinging and reports those devices offline. */
  private async closeSilentDevices(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.kind !== "device" || ws.readyState !== WebSocket.OPEN || !this.silent(ws, a)) continue;
      try {
        ws.close(4008, "no ping");
      } catch {
        // already closed
      }
      await this.onGone(ws);
    }
  }

  private silent(ws: WebSocket, a: Attachment & { kind: "device" }): boolean {
    // Sockets accepted before `since` existed count from now until their next ping.
    const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? a.since ?? Date.now();
    return Date.now() - last > DEVICE_SILENT_MS;
  }

  private live(ws: WebSocket): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const a = ws.deserializeAttachment() as Attachment | null;
    return a?.kind !== "device" || !this.silent(ws, a);
  }

  private socket(tag: string, except?: WebSocket): WebSocket | undefined {
    return this.ctx.getWebSockets(tag).find((ws) => ws !== except && this.live(ws));
  }

  private onlineDevices(): string[] {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.kind === "device" && this.live(ws)) ids.add(a.id);
    }
    return [...ids];
  }

  private broadcast(msg: HubToClient): void {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.kind === "client") send(ws, msg);
    }
  }

  private fail(ws: WebSocket, code: HubErrorCode, message: string): void {
    send(ws, { t: "error", code, message });
  }

  private async sessionValid(sessionId: string): Promise<boolean> {
    const row = await this.env.DB.prepare("SELECT 1 FROM sessions WHERE id_hash = ? AND expires_at > ?")
      .bind(sessionId, Date.now())
      .first();
    return !!row;
  }

  private async touchDevice(deviceId: string): Promise<void> {
    await this.env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(Date.now(), deviceId).run();
  }
}

function isSignal(m: unknown): m is { t: "signal"; to: string; sid: string; data: ClientToHub["data"] } {
  const x = m as Record<string, unknown> | null;
  return (
    !!x &&
    x.t === "signal" &&
    typeof x.to === "string" &&
    typeof x.sid === "string" &&
    x.sid.length <= 128 &&
    typeof x.data === "object" &&
    x.data !== null
  );
}

function send(ws: WebSocket, msg: HubToClient | HubToDaemon): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket closed between lookup and send; its close handler cleans up.
  }
}
