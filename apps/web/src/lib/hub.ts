// The one WebSocket per tab to the AccountHub: presence + signaling relay.

import {
  type ClientToHub,
  HUB_PING,
  HUB_PONG,
  type HubErrorCode,
  type HubToClient,
  type SignalData,
} from "@everywhere/protocol";
import { useSyncExternalStore } from "react";
import { api } from "./api";

export type HubStatus = "idle" | "connecting" | "open" | "closed";

export interface HubSnapshot {
  status: HubStatus;
  /** False until the first `presence` snapshot after (re)connecting. */
  presenceKnown: boolean;
  online: ReadonlySet<string>;
}

/** A WebRTC negotiation waiting on hub messages for one `sid`. */
export interface SignalSink {
  onSignal(data: SignalData): void;
  onHubError(code: HubErrorCode, message: string): void;
}

const PING_INTERVAL_MS = 25_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 15_000;
/** The hub closes a browser socket with this when its session is signed out or expires. */
const CLOSE_SESSION_REVOKED = 4003;

class Hub {
  private ws: WebSocket | null = null;
  private running = false;
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private sinks = new Map<string, SignalSink>();
  private listeners = new Set<() => void>();
  private snap: HubSnapshot = { status: "idle", presenceKnown: false, online: new Set() };

  /** Called when the socket can't be opened because the session is gone. */
  onUnauthorized: (() => void) | null = null;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "bye");
    this.sinks.clear();
    this.update({ status: "idle", presenceKnown: false, online: new Set() });
  }

  getSnapshot = (): HubSnapshot => this.snap;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  isOnline(deviceId: string): boolean {
    return this.snap.online.has(deviceId);
  }

  /** Returns false if the socket isn't open (the message is dropped). */
  send(msg: ClientToHub): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  register(sid: string, sink: SignalSink): () => void {
    this.sinks.set(sid, sink);
    return () => {
      if (this.sinks.get(sid) === sink) this.sinks.delete(sid);
    };
  }

  private connect(): void {
    if (!this.running) return;
    this.update({ ...this.snap, status: "connecting" });
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/ws`);
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.attempt = 0;
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(HUB_PING);
      }, PING_INTERVAL_MS);
      // Presence stays "unknown" until the hub's snapshot arrives.
      this.update({ ...this.snap, status: "open", presenceKnown: false });
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== "string" || ev.data === HUB_PONG) return;
      let msg: HubToClient;
      try {
        msg = JSON.parse(ev.data) as HubToClient;
      } catch {
        return;
      }
      this.handle(msg);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      // Any in-flight negotiation was addressed to the old connection id.
      this.sinks.clear();
      this.update({ ...this.snap, status: "closed", presenceKnown: false });
      if (!this.running) return;
      if (ev.code === CLOSE_SESSION_REVOKED) {
        // Signed out elsewhere (or expired): reconnecting would only 401.
        // Confirm with the API before giving up, then resume if still signed in.
        void this.checkSession().then((signedIn) => {
          if (signedIn !== false) this.scheduleReconnect();
        });
        return;
      }
      // A failed upgrade (e.g. 401) looks the same as a network error; ask the API which it was.
      if (!opened) void this.checkSession();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    clearTimeout(this.retryTimer);
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt++);
    const jitter = delay * (0.8 + Math.random() * 0.4);
    this.retryTimer = setTimeout(() => this.connect(), jitter);
  }

  /**
   * Stops the hub and reports `onUnauthorized` if the session is gone.
   * Resolves to whether we're signed in, or null if the API is unreachable.
   */
  private async checkSession(): Promise<boolean | null> {
    try {
      const me = await api.me();
      if (!me.user && this.running) {
        this.stop();
        this.onUnauthorized?.();
      }
      return !!me.user;
    } catch {
      // Network is down; keep retrying the socket.
      return null;
    }
  }

  private handle(msg: HubToClient): void {
    switch (msg.t) {
      case "presence":
        this.update({ ...this.snap, presenceKnown: true, online: new Set(msg.online) });
        return;
      case "presence.update": {
        const online = new Set(this.snap.online);
        if (msg.online) online.add(msg.deviceId);
        else online.delete(msg.deviceId);
        this.update({ ...this.snap, online });
        return;
      }
      case "signal":
        this.sinks.get(msg.sid)?.onSignal(msg.data);
        return;
      case "error":
        if (msg.sid) this.sinks.get(msg.sid)?.onHubError(msg.code, msg.message);
        else console.warn(`hub error ${msg.code}: ${msg.message}`);
        return;
    }
  }

  private update(next: HubSnapshot): void {
    this.snap = next;
    for (const fn of this.listeners) fn();
  }
}

export const hub = new Hub();

export function useHub(): HubSnapshot {
  return useSyncExternalStore(hub.subscribe, hub.getSnapshot);
}

/** `undefined` while presence is unknown (hub not yet connected). */
export function useDeviceOnline(deviceId: string): boolean | undefined {
  const snap = useHub();
  return snap.presenceKnown ? snap.online.has(deviceId) : undefined;
}
