import { DurableObject } from "cloudflare:workers";
import type {
  ClientToHub,
  DaemonToHub,
  HubErrorCode,
  HubToClient,
  HubToDaemon,
} from "@everywhere/protocol";
import { HUB_PING, HUB_PONG } from "@everywhere/protocol";
import { randomId } from "./crypto";
import { versionAtLeast } from "./version";

type Attachment = { kind: "device"; id: string } | { kind: "client"; id: string };

export const HUB_KIND_HEADER = "x-ew-kind";
export const HUB_ID_HEADER = "x-ew-id";

/**
 * One per account. Holds a hibernatable WebSocket for every connected daemon
 * and browser tab, relays WebRTC signaling between them, and broadcasts device
 * presence. It never sees terminal data.
 */
export class AccountHub extends DurableObject<Env> {
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
      server.serializeAttachment({ kind: "device", id: deviceId } satisfies Attachment);
      this.broadcast({ t: "presence.update", deviceId, online: true });
      await this.touchDevice(deviceId);
    } else {
      const connId = randomId();
      this.ctx.acceptWebSocket(server, [`client:${connId}`]);
      server.serializeAttachment({ kind: "client", id: connId } satisfies Attachment);
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
      if (m.t !== "signal") return this.fail(ws, "bad_message", "unknown message");
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
      }
      return;
    }
    if (m.t === "signal") {
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

  /** Called by the Worker when a device is revoked. */
  async revokeDevice(deviceId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(`device:${deviceId}`)) {
      this.fail(ws, "revoked", "device was removed");
      ws.close(4003, "revoked");
    }
    this.broadcast({ t: "presence.update", deviceId, online: false });
  }

  private async onGone(ws: WebSocket): Promise<void> {
    const me = ws.deserializeAttachment() as Attachment | null;
    if (me?.kind !== "device") return;
    // A replacement socket may already be open for the same device.
    if (this.socket(`device:${me.id}`, ws)) return;
    this.broadcast({ t: "presence.update", deviceId: me.id, online: false });
    await this.touchDevice(me.id);
  }

  private socket(tag: string, except?: WebSocket): WebSocket | undefined {
    return this.ctx
      .getWebSockets(tag)
      .find((ws) => ws !== except && ws.readyState === WebSocket.OPEN);
  }

  private onlineDevices(): string[] {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.kind === "device" && ws.readyState === WebSocket.OPEN) ids.add(a.id);
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

  private async touchDevice(deviceId: string): Promise<void> {
    await this.env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(Date.now(), deviceId).run();
  }
}

function send(ws: WebSocket, msg: HubToClient | HubToDaemon): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket closed between lookup and send; its close handler cleans up.
  }
}
