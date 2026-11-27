import { DurableObject } from "cloudflare:workers";
import type {
  ClientToHub,
  DaemonToHub,
  HubErrorCode,
  HubFeature,
  HubToClient,
  HubToDaemon,
  AgentMethod,
  AgentMethods,
  RemoteMethod,
  RemoteMethods,
  SignalData,
} from "@everywhere/protocol";
import { HUB_PING, HUB_PONG } from "@everywhere/protocol";
import { randomId } from "./crypto";
import { WORKER_PLUGINS } from "./plugins";
import type { HubHost, WorkerPlugin } from "./plugins/types";
import { versionAtLeast } from "./version";

type Attachment =
  | { kind: "device"; id: string; since?: number; features?: HubFeature[] }
  /**
   * viewing: "<deviceId>/<threadId>" while the tab shows that thread, visible and focused.
   * active: someone is using the tab and it shows alerts itself.
   */
  | { kind: "client"; id: string; session: string; viewing?: string; active?: boolean };

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
const MIN_SWEEP_MS = 15_000;

/** Hub features the core serves; plugins add theirs. */
const CORE_FEATURES: HubFeature[] = ["rpc", "agents"];
const KNOWN_FEATURES = new Set<HubFeature>([
  ...CORE_FEATURES,
  ...WORKER_PLUGINS.flatMap((p) => p.hubFeatures ?? []),
]);
const PLUGIN_BY_ID = new Map<string, WorkerPlugin>(WORKER_PLUGINS.map((p) => [p.id, p]));
const DAEMON_MSG_OWNER = new Map<string, WorkerPlugin>();
for (const p of WORKER_PLUGINS) {
  for (const t of Object.keys(p.daemonMessages ?? {})) DAEMON_MSG_OWNER.set(t, p);
}
const TEXT_DECODER = new TextDecoder();

export const HUB_KIND_HEADER = "x-ew-kind";
export const HUB_ID_HEADER = "x-ew-id";
export const HUB_SESSION_HEADER = "x-ew-session";

/**
 * One per account. Holds a hibernatable WebSocket for every connected daemon
 * and browser tab, relays WebRTC signaling between them, and broadcasts device
 * presence. It never sees browsers' terminal data; the only thread data
 * through it is thread names in push notifications.
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
      this.ctx.acceptWebSocket(server, ["device", `device:${deviceId}`]);
      server.serializeAttachment({ kind: "device", id: deviceId, since: Date.now() } satisfies Attachment);
      this.broadcast({ t: "presence.update", deviceId, online: true });
      // Only run the periodic silent-device sweep while at least one browser
      // client is connected; idle accounts stay fully hibernated.
      if (this.ctx.getWebSockets("client").length > 0 && (await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + DEVICE_SILENT_MS);
      }
    } else {
      const connId = randomId();
      const session = request.headers.get(HUB_SESSION_HEADER) ?? "";
      this.ctx.acceptWebSocket(server, ["client", `client:${connId}`, `session:${session}`]);
      server.serializeAttachment({ kind: "client", id: connId, session } satisfies Attachment);
      this.closeSilentDevices();
      send(server, { t: "presence", online: this.onlineDevices() } satisfies HubToClient);
      await this.scheduleNextSweep();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const me = ws.deserializeAttachment() as Attachment;
    let msg: unknown;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : TEXT_DECODER.decode(raw));
    } catch {
      return this.fail(ws, "bad_message", "invalid JSON");
    }

    if (me.kind === "client") {
      const m = msg as ClientToHub;
      if (m?.t === "viewing") {
        const viewing =
          typeof m.deviceId === "string" && typeof m.threadId === "string" && m.deviceId.length + m.threadId.length < 256
            ? `${m.deviceId}/${m.threadId}`
            : undefined;
        ws.serializeAttachment({ ...me, viewing, active: m.active === true } satisfies Attachment);
        return;
      }
      if (!isSignal(m)) return this.fail(ws, "bad_message", "unknown message");
      // Re-check the session before each new connection, so sessions removed
      // out of band (expiry, reset-password script) can't open new peers.
      if (m.data.type === "offer") {
        if (!(await this.sessionValid(me.session))) {
          ws.close(4003, "session expired");
          return;
        }
        this.closeSilentDevices();
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
        const features = m.features.filter((f): f is HubFeature => KNOWN_FEATURES.has(f));
        ws.serializeAttachment({ ...me, features } satisfies Attachment);
        // Plugins hear of daemons that serve their features (the Claude token goes to those that take it).
        for (const p of WORKER_PLUGINS) {
          const theirs = features.filter((f) => p.hubFeatures?.includes(f));
          if (p.onDaemonHello && theirs.length) this.ctx.waitUntil(p.onDaemonHello(this.host(p), me.id, theirs));
        }
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
    // Messages plugins own (notify: push notifications).
    const t = (m as { t?: unknown } | null)?.t;
    const owner = typeof t === "string" ? DAEMON_MSG_OWNER.get(t) : undefined;
    if (owner && typeof t === "string") {
      this.ctx.waitUntil(owner.daemonMessages![t]!(this.host(owner), me.id, m));
      return;
    }
    this.fail(ws, "bad_message", "unknown message");
  }

  /** Calls a plugin's hub method (from the plugin's routes; see callHub). */
  async plugin(id: string, method: string, args: unknown): Promise<unknown> {
    const p = PLUGIN_BY_ID.get(id);
    const fn = p?.hubMethods?.[method];
    if (!p || !fn) throw new Error(`no hub method ${id}.${method}`);
    return fn(this.host(p), args);
  }

  /** What the hub gives a plugin: its own storage keys, rpc to daemons, the browsers. */
  private host(p: WorkerPlugin): HubHost {
    const key = (k: string) => (p.legacyStorageKeys?.includes(k) ? k : `plugin:${p.id}:${k}`);
    return {
      env: this.env,
      storage: {
        get: (k) => this.ctx.storage.get(key(k)),
        put: (k, v) => this.ctx.storage.put(key(k), v),
        delete: async (k) => void (await this.ctx.storage.delete(key(k))),
        list: async <T,>() => {
          const prefix = `plugin:${p.id}:`;
          const out = new Map<string, T>();
          for (const [k, v] of await this.ctx.storage.list<T>({ prefix })) out.set(k.slice(prefix.length), v);
          return out;
        },
      },
      deviceRpc: (deviceId, method, params, timeoutMs) => this.deviceRpc(deviceId, method, params, timeoutMs),
      devicesWith: (feature) => this.devicesWith(feature),
      broadcast: (msg) => this.broadcast(msg),
      viewing: (deviceId, threadId) => {
        const target = `${deviceId}/${threadId}`;
        return this.ctx.getWebSockets("client").some((ws) => {
          const a = ws.deserializeAttachment() as Attachment | null;
          return a?.kind === "client" && a.viewing === target;
        });
      },
      inUse: () =>
        this.ctx.getWebSockets("client").some((ws) => {
          if (ws.readyState !== WebSocket.OPEN) return false;
          const a = ws.deserializeAttachment() as Attachment | null;
          return a?.kind === "client" && !!a.active;
        }),
      waitUntil: (pr) => this.ctx.waitUntil(pr),
    };
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.onGone(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.onGone(ws);
  }

  /** Periodic sweep for daemons that went silent, while both clients and devices are connected. */
  override async alarm(): Promise<void> {
    this.closeSilentDevices();
    await this.scheduleNextSweep();
  }

  /** Schedules the next silence sweep at the earliest device's deadline, only when clients watch. */
  private async scheduleNextSweep(): Promise<void> {
    if (this.ctx.getWebSockets("client").length === 0) return;
    const devices = this.ctx.getWebSockets("device");
    if (devices.length === 0) return;
    const now = Date.now();
    let earliest = Infinity;
    for (const ws of devices) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.kind !== "device") continue;
      const last = this.lastActivity(ws, a, now);
      if (last < earliest) earliest = last;
    }
    if (!Number.isFinite(earliest)) return;
    const nextAt = Math.min(now + DEVICE_SILENT_MS, Math.max(now + MIN_SWEEP_MS, earliest + DEVICE_SILENT_MS + 1000));
    await this.ctx.storage.setAlarm(nextAt);
  }

  /** The online devices, and which of them answer rpc requests and connected agents'. */
  async devices(): Promise<{ id: string; rpc: boolean; agents: boolean }[]> {
    const now = Date.now();
    const out = new Map<string, { id: string; rpc: boolean; agents: boolean }>();
    for (const ws of this.ctx.getWebSockets("device")) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.kind === "device" && !this.silent(ws, a, now)) {
        out.set(a.id, { id: a.id, rpc: !!a.features?.includes("rpc"), agents: !!a.features?.includes("agents") });
      }
    }
    return [...out.values()];
  }

  /**
   * Sends a request of the Worker's own to a daemon over its socket (see
   * RemoteMethods) and waits for the answer.
   */
  async deviceRpc<M extends RemoteMethod>(
    deviceId: string,
    method: M,
    params: RemoteMethods[M][0],
    timeoutMs = 30_000,
  ): Promise<DeviceRpcResult<RemoteMethods[M][1]>> {
    return (await this.relay(deviceId, "rpc", { method, params }, timeoutMs)) as DeviceRpcResult<RemoteMethods[M][1]>;
  }

  /**
   * Relays a connected agent's request (agent: its name) to a daemon (see
   * AgentMethods). The daemon answers only while the device allows
   * connected agents, and only those methods.
   */
  async agentRpc<M extends AgentMethod>(
    deviceId: string,
    agent: string,
    method: M,
    params: AgentMethods[M][0],
    timeoutMs = 30_000,
  ): Promise<DeviceRpcResult<AgentMethods[M][1]>> {
    return (await this.relay(deviceId, "agents", { method, params, agent }, timeoutMs)) as DeviceRpcResult<AgentMethods[M][1]>;
  }

  private async relay(
    deviceId: string,
    feature: HubFeature,
    req: { method: string; params: unknown; agent?: string },
    timeoutMs: number,
  ): Promise<DeviceRpcResult> {
    const ws = this.socket(`device:${deviceId}`);
    if (!ws) return { ok: false, code: "offline", message: "the device is offline" };
    const a = ws.deserializeAttachment() as Attachment;
    if (a.kind !== "device" || !a.features?.includes(feature)) {
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
    send(ws, { t: "rpc", id, ...req } satisfies HubToDaemon);
    return result;
  }

  /** Connected daemons that announced a hub feature. */
  private devicesWith(feature: HubFeature): string[] {
    const now = Date.now();
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets("device")) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.kind === "device" && !this.silent(ws, a, now) && a.features?.includes(feature)) ids.add(a.id);
    }
    return [...ids];
  }

  /** Called by the Worker when a device is revoked. */
  async revokeDevice(deviceId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(`device:${deviceId}`)) {
      this.fail(ws, "revoked", "device was removed");
      ws.close(4003, "revoked");
    }
    this.rejectPending(deviceId, "device was removed");
    this.broadcast({ t: "presence.update", deviceId, online: false });
  }

  /**
   * Called when sessions are signed out or revoked: closes their sockets and
   * tells daemons to drop any WebRTC peers those browsers opened.
   */
  async revokeSessions(sessionIds: string[]): Promise<void> {
    const conns: string[] = [];
    for (const sessionId of sessionIds) {
      for (const ws of this.ctx.getWebSockets(`session:${sessionId}`)) {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (a?.kind === "client") {
          conns.push(a.id);
          ws.close(4003, "signed out");
        }
      }
    }
    if (conns.length === 0) return;
    const frames = conns.map((connId) => JSON.stringify({ t: "client.revoked", connId } satisfies HubToDaemon));
    for (const ws of this.ctx.getWebSockets("device")) {
      for (const frame of frames) sendText(ws, frame);
    }
  }

  private rejectPending(deviceId: string, message: string): void {
    for (const [id, p] of this.pending) {
      if (p.deviceId !== deviceId) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve({ ok: false, code: "offline", message });
    }
  }

  private onGone(ws: WebSocket, touch = true): string | null {
    const me = ws.deserializeAttachment() as Attachment | null;
    if (me?.kind !== "device") return null;
    // A replacement socket may already be open for the same device.
    if (this.socket(`device:${me.id}`, ws)) return null;
    this.rejectPending(me.id, "the device disconnected");
    this.broadcast({ t: "presence.update", deviceId: me.id, online: false });
    if (touch) this.ctx.waitUntil(this.touchDevice(me.id));
    return me.id;
  }

  /** Closes daemon sockets that stopped pinging and reports those devices offline. */
  private closeSilentDevices(): void {
    const now = Date.now();
    const touched: string[] = [];
    for (const ws of this.ctx.getWebSockets("device")) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.kind !== "device" || !this.silent(ws, a, now)) continue;
      try {
        ws.close(4008, "no ping");
      } catch {
        // already closed
      }
      const id = this.onGone(ws, false);
      if (id) touched.push(id);
    }
    if (touched.length > 0) {
      this.ctx.waitUntil(this.touchDevices(touched, now));
    }
  }

  private lastActivity(ws: WebSocket, a: Attachment & { kind: "device" }, now: number): number {
    // Sockets accepted before `since` existed count from now until their next ping.
    return this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? a.since ?? now;
  }

  private silent(ws: WebSocket, a: Attachment & { kind: "device" }, now = Date.now()): boolean {
    return now - this.lastActivity(ws, a, now) > DEVICE_SILENT_MS;
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
    const now = Date.now();
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets("device")) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.kind === "device" && !this.silent(ws, a, now)) ids.add(a.id);
    }
    return [...ids];
  }

  private broadcast(msg: HubToClient): void {
    const clients = this.ctx.getWebSockets("client");
    if (clients.length === 0) return;
    const text = JSON.stringify(msg);
    for (const ws of clients) sendText(ws, text);
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

  private async touchDevices(deviceIds: string[], now: number): Promise<void> {
    if (deviceIds.length === 1) {
      await this.env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(now, deviceIds[0]!).run();
      return;
    }
    const placeholders = deviceIds.map(() => "?").join(",");
    await this.env.DB.prepare(`UPDATE devices SET last_seen_at = ? WHERE id IN (${placeholders})`)
      .bind(now, ...deviceIds)
      .run();
  }
}

function isSignal(m: unknown): m is { t: "signal"; to: string; sid: string; data: SignalData } {
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

function sendText(ws: WebSocket, text: string): void {
  try {
    ws.send(text);
  } catch {
    // Socket closed between lookup and send; its close handler cleans up.
  }
}

function send(ws: WebSocket, msg: HubToClient | HubToDaemon): void {
  sendText(ws, JSON.stringify(msg));
}
