// One WebRTC PeerConnection per device per tab, straight to the daemon.
// Signaling goes through the hub; everything else rides data channels.

import {
  CONTROL_CHANNEL,
  type HubErrorCode,
  type IceCandidate,
  type RpcEvent,
  type RpcMethod,
  type RpcMethods,
  type RpcRequest,
  type RpcResponse,
  type SignalData,
  TERM_CHANNEL_PREFIX,
  type TermClientMsg,
  type TermDaemonMsg,
} from "@everywhere/protocol";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { hub } from "./hub";

export type PeerState = "idle" | "connecting" | "connected" | "failed" | "offline";

export interface PeerSnapshot {
  state: PeerState;
  /** Human-readable reason for `failed`. */
  error: string | null;
  /** Bumps on every successful connection; data channels from older generations are dead. */
  generation: number;
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
const CONNECT_TIMEOUT_MS = 15_000;
const DISCONNECT_GRACE_MS = 5_000;
const RPC_TIMEOUT_MS = 15_000;
export const UNREACHABLE_MESSAGE = "Couldn't reach device — is this browser on your tailnet?";

function randomSid(): string {
  // crypto.randomUUID needs a secure context; getRandomValues doesn't.
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toWireCandidate(c: RTCIceCandidate): IceCandidate {
  const j = c.toJSON();
  return {
    candidate: j.candidate ?? "",
    sdpMid: j.sdpMid ?? null,
    sdpMLineIndex: j.sdpMLineIndex ?? null,
    usernameFragment: j.usernameFragment ?? null,
  };
}

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DevicePeer {
  private snap: PeerSnapshot = { state: "idle", error: null, generation: 0 };
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: RpcEvent) => void>();
  private viewers = 0;

  private pc: RTCPeerConnection | null = null;
  private control: RTCDataChannel | null = null;
  private sid: string | null = null;
  private unregister: (() => void) | null = null;
  private remoteDescriptionSet = false;
  private queuedCandidates: RTCIceCandidateInit[] = [];
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;

  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private unsubHub: () => void;

  constructor(readonly deviceId: string) {
    this.unsubHub = hub.subscribe(this.onHubChange);
  }

  // --- store ----------------------------------------------------------------

  getSnapshot = (): PeerSnapshot => this.snap;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<PeerSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  // --- lifecycle ------------------------------------------------------------

  /** Mark the device as being viewed. Connects lazily; returns a release fn. */
  acquire(): () => void {
    // Coming back to a device that failed earlier is an implicit retry.
    if (this.viewers++ === 0 && this.snap.state === "failed") this.set({ state: "idle", error: null });
    this.ensure();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.viewers--;
    };
  }

  /** Manual retry after `failed`. */
  retry(): void {
    this.reconnectAttempt = 0;
    this.teardown();
    this.set({ state: "idle", error: null });
    this.ensure();
  }

  /** Permanently close (logout). */
  dispose(): void {
    this.unsubHub();
    this.teardown();
    this.set({ state: "idle", error: null });
  }

  private ensure(): void {
    if (this.viewers === 0) return;
    const { state } = this.snap;
    if (state === "connected" || state === "connecting" || state === "failed") return;
    const h = hub.getSnapshot();
    if (h.presenceKnown && !h.online.has(this.deviceId)) {
      this.set({ state: "offline", error: null });
      return;
    }
    this.set({ state: "connecting", error: null });
    this.kick();
  }

  /** Start negotiating if we're meant to be connecting and the hub is ready. */
  private kick(): void {
    if (this.snap.state !== "connecting" || this.pc) return;
    const h = hub.getSnapshot();
    if (h.status !== "open" || !h.presenceKnown) return; // onHubChange retries
    if (!h.online.has(this.deviceId)) {
      this.set({ state: "offline", error: null });
      return;
    }
    void this.negotiate();
  }

  private onHubChange = (): void => {
    const h = hub.getSnapshot();
    const { state } = this.snap;
    if (h.presenceKnown && !h.online.has(this.deviceId)) {
      if (state === "offline") return;
      if (state === "idle" && this.viewers === 0) return;
      this.teardown();
      this.set({ state: "offline", error: null });
      return;
    }
    if (h.presenceKnown && state === "offline") {
      // Device came back: reconnect if someone is looking at it.
      this.set({ state: "idle", error: null });
      this.ensure();
      return;
    }
    if (state === "connecting") {
      if (h.status !== "open" && this.pc) {
        // The daemon would answer our old hub connection id; start over once it's back.
        this.teardown();
      }
      this.kick();
    }
  };

  private async negotiate(): Promise<void> {
    this.teardown();
    const sid = randomSid();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const control = pc.createDataChannel(CONTROL_CHANNEL, { ordered: true });
    this.pc = pc;
    this.control = control;
    this.sid = sid;
    this.remoteDescriptionSet = false;
    this.queuedCandidates = [];

    const alive = () => this.pc === pc;
    const signal = (data: SignalData) => hub.send({ t: "signal", to: this.deviceId, sid, data });

    this.unregister = hub.register(sid, {
      onSignal: (data) => {
        if (alive()) void this.onSignal(pc, data);
      },
      onHubError: (code, message) => {
        if (alive()) this.onHubError(code, message);
      },
    });

    pc.onicecandidate = (ev) => {
      if (alive() && ev.candidate?.candidate) signal({ type: "candidate", candidate: toWireCandidate(ev.candidate) });
    };

    pc.onconnectionstatechange = () => {
      if (!alive()) return;
      clearTimeout(this.disconnectTimer);
      if (pc.connectionState === "failed") this.onDrop();
      else if (pc.connectionState === "disconnected") {
        this.disconnectTimer = setTimeout(() => {
          if (alive() && pc.connectionState === "disconnected") this.onDrop();
        }, DISCONNECT_GRACE_MS);
      }
    };

    control.onopen = () => {
      if (!alive()) return;
      clearTimeout(this.connectTimer);
      this.reconnectAttempt = 0;
      this.set({ state: "connected", error: null, generation: this.snap.generation + 1 });
    };
    control.onclose = () => {
      if (alive()) this.onDrop();
    };
    control.onmessage = (ev) => {
      if (alive() && typeof ev.data === "string") this.onControlMessage(ev.data);
    };

    this.connectTimer = setTimeout(() => {
      if (alive() && this.snap.state !== "connected") this.fail(UNREACHABLE_MESSAGE);
    }, CONNECT_TIMEOUT_MS);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!alive()) return;
      // If the hub dropped in between, onHubChange restarts negotiation.
      signal({ type: "offer", sdp: offer.sdp ?? "" });
    } catch (e) {
      if (alive()) this.fail(`WebRTC setup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async onSignal(pc: RTCPeerConnection, data: SignalData): Promise<void> {
    try {
      switch (data.type) {
        case "answer": {
          await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
          this.remoteDescriptionSet = true;
          const queued = this.queuedCandidates;
          this.queuedCandidates = [];
          for (const c of queued) await pc.addIceCandidate(c);
          return;
        }
        case "candidate": {
          const init: RTCIceCandidateInit = {
            candidate: data.candidate.candidate,
            sdpMid: data.candidate.sdpMid ?? null,
            sdpMLineIndex: data.candidate.sdpMLineIndex ?? null,
            usernameFragment: data.candidate.usernameFragment ?? null,
          };
          if (this.remoteDescriptionSet) await pc.addIceCandidate(init);
          else this.queuedCandidates.push(init);
          return;
        }
        case "bye":
          this.onDrop();
          return;
        case "offer":
          // We're always the offerer; ignore.
          return;
      }
    } catch (e) {
      console.warn("signal handling failed", e);
    }
  }

  private onHubError(code: HubErrorCode, message: string): void {
    if (code === "device_offline") {
      this.teardown();
      this.set({ state: "offline", error: null });
    } else {
      this.fail(message || code);
    }
  }

  /** An established (or establishing) connection went away. */
  private onDrop(): void {
    const wasConnected = this.snap.state === "connected";
    this.teardown();
    if (!wasConnected) {
      this.fail(UNREACHABLE_MESSAGE);
      return;
    }
    if (this.viewers === 0) {
      this.set({ state: "idle", error: null });
      return;
    }
    // Reconnect with a fresh sid; a second ICE failure lands in `failed`.
    this.set({ state: "connecting", error: null });
    const delay = Math.min(8000, 500 * 2 ** this.reconnectAttempt++);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.kick(), delay);
  }

  private fail(message: string): void {
    this.teardown();
    this.set({ state: "failed", error: message });
  }

  private teardown(): void {
    clearTimeout(this.connectTimer);
    clearTimeout(this.disconnectTimer);
    clearTimeout(this.reconnectTimer);
    this.unregister?.();
    this.unregister = null;
    const pc = this.pc;
    const sid = this.sid;
    this.pc = null;
    this.control = null;
    this.sid = null;
    if (pc) {
      if (sid) hub.send({ t: "signal", to: this.deviceId, sid, data: { type: "bye" } });
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Connection to device closed"));
    }
    this.pending.clear();
  }

  // --- control RPC ----------------------------------------------------------

  call<M extends RpcMethod>(
    method: M,
    params: RpcMethods[M][0],
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<RpcMethods[M][1]> {
    const ch = this.control;
    if (!ch || ch.readyState !== "open") return Promise.reject(new Error("Not connected to device"));
    const id = this.nextId++;
    const req: RpcRequest<M> = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        ch.send(JSON.stringify(req));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  onEvent(fn: (e: RpcEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  private onControlMessage(raw: string): void {
    let msg: RpcResponse | RpcEvent;
    try {
      msg = JSON.parse(raw) as RpcResponse | RpcEvent;
    } catch {
      return;
    }
    if ("event" in msg) {
      for (const fn of this.eventListeners) fn(msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if ("error" in msg) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  // --- terminals ------------------------------------------------------------

  /** Opens a `term:<threadId>` channel. Throws if not connected. */
  openTerminal(threadId: string, handlers: TerminalHandlers): TerminalChannel {
    if (!this.pc || this.snap.state !== "connected") throw new Error("Not connected to device");
    const ch = this.pc.createDataChannel(`${TERM_CHANNEL_PREFIX}${threadId}`, { ordered: true });
    ch.binaryType = "arraybuffer";
    return new TerminalChannel(ch, handlers);
  }
}

export interface TerminalHandlers {
  onOpen(): void;
  onOutput(bytes: Uint8Array): void;
  onControl(msg: TermDaemonMsg): void;
  onClose(): void;
}

export class TerminalChannel {
  private encoder = new TextEncoder();
  private closed = false;

  constructor(
    private ch: RTCDataChannel,
    h: TerminalHandlers,
  ) {
    ch.onopen = () => {
      if (!this.closed) h.onOpen();
    };
    ch.onmessage = (ev) => {
      if (this.closed) return;
      if (typeof ev.data === "string") {
        try {
          h.onControl(JSON.parse(ev.data) as TermDaemonMsg);
        } catch {
          // ignore malformed control frames
        }
      } else if (ev.data instanceof ArrayBuffer) {
        h.onOutput(new Uint8Array(ev.data));
      }
    };
    ch.onclose = () => {
      if (this.closed) return;
      this.closed = true;
      h.onClose();
    };
  }

  get isOpen(): boolean {
    return !this.closed && this.ch.readyState === "open";
  }

  sendControl(msg: TermClientMsg): void {
    if (this.isOpen) this.ch.send(JSON.stringify(msg));
  }

  sendInput(data: string): void {
    if (this.isOpen) this.ch.send(this.encoder.encode(data));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ch.close();
  }
}

// --- registry -----------------------------------------------------------------

const peers = new Map<string, DevicePeer>();

export function getPeer(deviceId: string): DevicePeer {
  let p = peers.get(deviceId);
  if (!p) {
    p = new DevicePeer(deviceId);
    peers.set(deviceId, p);
  }
  return p;
}

export function disposeAllPeers(): void {
  for (const p of peers.values()) p.dispose();
  peers.clear();
}

// --- React ----------------------------------------------------------------------

/** Holds the device's peer open while mounted and returns it with its live state. */
export function usePeer(deviceId: string): { peer: DevicePeer } & PeerSnapshot {
  const peer = getPeer(deviceId);
  useEffect(() => peer.acquire(), [peer]);
  const snap = useSyncExternalStore(peer.subscribe, peer.getSnapshot);
  return { peer, ...snap };
}

export interface RpcQuery<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

/**
 * Runs an RPC whenever the peer (re)connects, when params change, and when one
 * of `refetchOn` events arrives. Keeps the previous data while refetching.
 */
export function useRpc<M extends RpcMethod>(
  peer: DevicePeer,
  method: M,
  params: RpcMethods[M][0],
  refetchOn: RpcEvent["event"][] = [],
  enabled = true,
): RpcQuery<RpcMethods[M][1]> {
  const { state, generation } = useSyncExternalStore(peer.subscribe, peer.getSnapshot);
  const [data, setData] = useState<RpcMethods[M][1] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(params);
  const connected = state === "connected";
  const events = refetchOn.join(",");
  const lastKey = useRef(key);

  useEffect(() => {
    if (!enabled || !connected) return;
    if (lastKey.current !== key) {
      lastKey.current = key;
      setData(undefined);
    }
    let cancelled = false;
    setLoading(true);
    peer
      .call(method, JSON.parse(key) as RpcMethods[M][0])
      .then((r) => {
        if (cancelled) return;
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [peer, method, key, connected, generation, tick, enabled]);

  useEffect(() => {
    if (!events) return;
    const names = events.split(",");
    return peer.onEvent((e) => {
      if (names.includes(e.event)) setTick((t) => t + 1);
    });
  }, [peer, events]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, refetch };
}
