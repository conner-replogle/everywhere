// One WebRTC PeerConnection per device per tab, straight to the daemon.
// Signaling goes through the hub; everything else rides data channels.

import {
  AGENT_CHANNEL_PREFIX,
  type AgentAttachment,
  BROWSER_CHANNEL_PREFIX,
  type AgentClientMsg,
  type AgentDaemonMsg,
  CONTROL_CHANNEL,
  FILE_CHANNEL_PREFIX,
  type FileClientMsg,
  type FileDaemonMsg,
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
  UPLOAD_CHANNEL_PREFIX,
  type UploadResult,
  type UploadStart,
} from "@everywhere/protocol";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { BrowserChannel, type BrowserHandlers } from "./browser-channel";
import { hub } from "./hub";

export type PeerState = "idle" | "connecting" | "connected" | "failed" | "offline";

export interface PeerSnapshot {
  state: PeerState;
  /** Human-readable reason for `failed`. */
  error: string | null;
  /** Bumps on every successful connection; data channels from older generations are dead. */
  generation: number;
}

export type PeerLogKind = "state" | "signal" | "ice" | "error" | "info";

export interface PeerLogEntry {
  at: number;
  kind: PeerLogKind;
  message: string;
}

/** Browser-side connection facts for the debug panel (see also `pc` for getStats). */
export interface PeerDebugInfo {
  deviceId: string;
  sid: string | null;
  state: PeerState;
  error: string | null;
  generation: number;
  viewers: number;
  reconnectAttempt: number;
  offerSentAt: number | null;
  answerReceivedAt: number | null;
  connectedAt: number | null;
  candidatesSent: number;
  candidatesReceived: number;
  connectionState: RTCPeerConnectionState | null;
  iceConnectionState: RTCIceConnectionState | null;
  iceGatheringState: RTCIceGatheringState | null;
  signalingState: RTCSignalingState | null;
}

const LOG_LIMIT = 200;

/** "host udp 100.101.102.103:41641" from an a=candidate line. */
function describeCandidate(line: string): string {
  // candidate:<foundation> <component> <proto> <priority> <addr> <port> typ <type> ...
  const [, , proto, , addr, port, , type] = line.replace(/^candidate:/, "").split(" ");
  if (!type) return line;
  return `${type} ${proto?.toLowerCase()} ${addr}:${port}`;
}

const STUN_ONLY: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
const CONNECT_TIMEOUT_MS = 20_000;
const DISCONNECT_GRACE_MS = 5_000;
const RPC_TIMEOUT_MS = 15_000;
/** How long a liveness probe after coming back to the foreground may take. */
const PROBE_TIMEOUT_MS = 4_000;
const UPLOAD_CHUNK = 16 * 1024;
export const UNREACHABLE_MESSAGE = "Couldn't reach device — direct and relayed connections both failed.";
/** The offer went out through the hub but the daemon never answered it. */
export const NO_ANSWER_MESSAGE = "Device didn't respond.";

// STUN + short-lived Cloudflare TURN credentials from the Worker, cached until
// an hour before they expire. ICE prefers direct paths (LAN, Tailscale, NAT
// traversal); the TURN relay is only picked when none of them work.
let iceCache: { servers: RTCIceServer[]; turn: boolean; expiresAt: number } | null = null;

async function iceServers(): Promise<{ servers: RTCIceServer[]; turn: boolean }> {
  if (iceCache && iceCache.expiresAt - Date.now() > 60 * 60 * 1000) return iceCache;
  try {
    const r = await api.iceServers();
    iceCache = { servers: r.iceServers, turn: r.turn, expiresAt: r.expiresAt };
    return iceCache;
  } catch {
    return { servers: STUN_ONLY, turn: false };
  }
}

const FORCE_RELAY_KEY = "ew.forceRelay";

/** Debug switch: only use TURN relay candidates, to test the fallback path. */
export function forceRelay(): boolean {
  return localStorage.getItem(FORCE_RELAY_KEY) === "1";
}

export function setForceRelay(on: boolean): void {
  if (on) localStorage.setItem(FORCE_RELAY_KEY, "1");
  else localStorage.removeItem(FORCE_RELAY_KEY);
}

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

  // Debug bookkeeping; read by the debug panel on its own schedule, so it
  // doesn't notify subscribers.
  private log: PeerLogEntry[] = [];
  private offerSentAt: number | null = null;
  private answerReceivedAt: number | null = null;
  private connectedAt: number | null = null;
  private candidatesSent = 0;
  private candidatesReceived = 0;

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
    if (patch.state && patch.state !== this.snap.state) {
      this.record("state", `${this.snap.state} → ${patch.state}${patch.error ? `: ${patch.error}` : ""}`);
    }
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

  /** Manual retry after `failed`, or a forced reconnect from the debug panel. */
  retry(): void {
    this.record("info", "manual reconnect");
    this.reconnectAttempt = 0;
    this.teardown();
    this.set({ state: "idle", error: null });
    this.ensure();
  }

  /**
   * Makes sure the connection still works, e.g. after the app was in the
   * background: mobile browsers freeze the page and the network can change
   * underneath it. A dead or failed connection is redone right away.
   */
  checkAlive(): void {
    if (this.viewers === 0) return;
    const { state } = this.snap;
    if (state === "failed") {
      this.retry();
      return;
    }
    if (state === "connecting" && !this.pc) {
      // Waiting out a reconnect backoff: go now.
      clearTimeout(this.reconnectTimer);
      this.reconnectAttempt = 0;
      this.kick();
      return;
    }
    if (state !== "connected") return;
    const pc = this.pc;
    const reconnect = (why: string) => {
      if (this.pc !== pc) return;
      this.record("info", `${why}; reconnecting`);
      this.reconnectAttempt = 0;
      this.onDrop();
    };
    if (pc?.connectionState !== "connected") {
      reconnect(`connection ${pc?.connectionState ?? "gone"} after resume`);
      return;
    }
    this.call("device.info", {}, PROBE_TIMEOUT_MS).catch(() => reconnect("device stopped answering after resume"));
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

  private negotiateSeq = 0;

  private async negotiate(): Promise<void> {
    const seq = ++this.negotiateSeq;
    const ice = await iceServers();
    // A newer negotiation (or a state change) superseded this one while we waited.
    if (seq !== this.negotiateSeq || this.snap.state !== "connecting" || this.pc) return;
    this.teardown();
    const sid = randomSid();
    const relayOnly = forceRelay();
    this.record(
      "info",
      `negotiating sid ${sid} (${ice.turn ? "TURN fallback available" : "STUN only"}${relayOnly ? ", relay forced" : ""})`,
    );
    this.offerSentAt = null;
    this.answerReceivedAt = null;
    this.connectedAt = null;
    this.candidatesSent = 0;
    this.candidatesReceived = 0;
    const pc = new RTCPeerConnection({
      iceServers: ice.servers,
      iceTransportPolicy: relayOnly ? "relay" : "all",
    });
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
      if (!alive()) return;
      if (ev.candidate?.candidate) {
        this.candidatesSent++;
        this.record("signal", `candidate sent: ${describeCandidate(ev.candidate.candidate)}`);
        signal({ type: "candidate", candidate: toWireCandidate(ev.candidate) });
      } else if (!ev.candidate) {
        this.record("ice", `gathering complete (${this.candidatesSent} local candidates)`);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (alive()) this.record("ice", `iceConnectionState ${pc.iceConnectionState}`);
    };
    pc.onicegatheringstatechange = () => {
      if (alive()) this.record("ice", `iceGatheringState ${pc.iceGatheringState}`);
    };
    pc.onsignalingstatechange = () => {
      if (alive()) this.record("ice", `signalingState ${pc.signalingState}`);
    };

    pc.onconnectionstatechange = () => {
      if (!alive()) return;
      this.record("ice", `connectionState ${pc.connectionState}`);
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
      this.connectedAt = Date.now();
      this.record(
        "info",
        `control channel open${this.offerSentAt ? ` (${this.connectedAt - this.offerSentAt} ms after offer)` : ""}`,
      );
      clearTimeout(this.connectTimer);
      this.reconnectAttempt = 0;
      this.set({ state: "connected", error: null, generation: this.snap.generation + 1 });
    };
    control.onclose = () => {
      if (!alive()) return;
      this.record("info", "control channel closed");
      this.onDrop();
    };
    control.onmessage = (ev) => {
      if (alive() && typeof ev.data === "string") this.onControlMessage(ev.data);
    };

    this.connectTimer = setTimeout(() => {
      if (!alive() || this.snap.state === "connected") return;
      this.fail(this.answerReceivedAt === null ? NO_ANSWER_MESSAGE : UNREACHABLE_MESSAGE);
    }, CONNECT_TIMEOUT_MS);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!alive()) return;
      // If the hub dropped in between, onHubChange restarts negotiation.
      const sent = signal({ type: "offer", sdp: offer.sdp ?? "" });
      this.offerSentAt = Date.now();
      this.record("signal", sent ? "offer sent" : "offer dropped (hub not connected)");
    } catch (e) {
      if (alive()) this.fail(`WebRTC setup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async onSignal(pc: RTCPeerConnection, data: SignalData): Promise<void> {
    try {
      switch (data.type) {
        case "answer": {
          this.answerReceivedAt = Date.now();
          this.record("signal", "answer received");
          await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
          this.remoteDescriptionSet = true;
          const queued = this.queuedCandidates;
          this.queuedCandidates = [];
          for (const c of queued) await pc.addIceCandidate(c);
          return;
        }
        case "candidate": {
          this.candidatesReceived++;
          this.record("signal", `candidate received: ${describeCandidate(data.candidate.candidate)}`);
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
          this.record("signal", "bye received");
          this.onDrop();
          return;
        case "offer":
          // We're always the offerer; ignore.
          return;
      }
    } catch (e) {
      console.warn("signal handling failed", e);
      this.record("error", `handling ${data.type} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private onHubError(code: HubErrorCode, message: string): void {
    this.record("error", `hub error ${code}${message ? `: ${message}` : ""}`);
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
    this.record("info", `connection dropped; reconnect attempt ${this.reconnectAttempt} in ${delay} ms`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.kick(), delay);
  }

  private fail(message: string): void {
    this.record("error", message);
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
      pc.oniceconnectionstatechange = null;
      pc.onicegatheringstatechange = null;
      pc.onsignalingstatechange = null;
      pc.close();
      this.record("info", `closed sid ${sid}`);
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Connection to device closed"));
    }
    this.pending.clear();
  }

  // --- debug ----------------------------------------------------------------

  private record(kind: PeerLogKind, message: string): void {
    this.log.push({ at: Date.now(), kind, message });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
  }

  /** Oldest first, at most the last 200 events. */
  debugLog(): readonly PeerLogEntry[] {
    return this.log.slice();
  }

  /** The live RTCPeerConnection, for getStats(). Null between connections. */
  get peerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  debugInfo(): PeerDebugInfo {
    const pc = this.pc;
    return {
      deviceId: this.deviceId,
      sid: this.sid,
      state: this.snap.state,
      error: this.snap.error,
      generation: this.snap.generation,
      viewers: this.viewers,
      reconnectAttempt: this.reconnectAttempt,
      offerSentAt: this.offerSentAt,
      answerReceivedAt: this.answerReceivedAt,
      connectedAt: this.connectedAt,
      candidatesSent: this.candidatesSent,
      candidatesReceived: this.candidatesReceived,
      connectionState: pc?.connectionState ?? null,
      iceConnectionState: pc?.iceConnectionState ?? null,
      iceGatheringState: pc?.iceGatheringState ?? null,
      signalingState: pc?.signalingState ?? null,
    };
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

  /**
   * Uploads a file for a claude thread on its own `upload:<id>` channel.
   * Resolves with the stored attachment, whose id goes into `send`.
   */
  async upload(threadId: string, file: File, onProgress?: (sent: number) => void): Promise<AgentAttachment> {
    if (!this.pc || this.snap.state !== "connected") throw new Error("Not connected to device");
    const ch = this.pc.createDataChannel(`${UPLOAD_CHANNEL_PREFIX}${randomSid()}`, { ordered: true });
    ch.binaryType = "arraybuffer";
    ch.bufferedAmountLowThreshold = UPLOAD_CHUNK * 8;
    try {
      const result = new Promise<UploadResult>((resolve, reject) => {
        ch.onmessage = (ev) => {
          try {
            resolve(JSON.parse(ev.data as string) as UploadResult);
          } catch (e) {
            reject(e);
          }
        };
        ch.onclose = () => reject(new Error("Upload interrupted"));
      });
      await new Promise<void>((resolve, reject) => {
        ch.onopen = () => resolve();
        ch.onerror = () => reject(new Error("Couldn't open upload channel"));
      });
      const start: UploadStart = {
        t: "start",
        threadId,
        name: file.name || "pasted",
        mediaType: file.type || "application/octet-stream",
        size: file.size,
      };
      ch.send(JSON.stringify(start));
      for (let sent = 0; sent < file.size; ) {
        // Keep the send buffer small so progress is real and memory flat.
        if (ch.bufferedAmount > UPLOAD_CHUNK * 64) {
          await new Promise<void>((resolve) => {
            ch.onbufferedamountlow = () => resolve();
          });
        }
        const chunk = await file.slice(sent, sent + UPLOAD_CHUNK).arrayBuffer();
        ch.send(chunk);
        sent += chunk.byteLength;
        onProgress?.(sent);
      }
      ch.send(JSON.stringify({ t: "end" }));
      const r = await result;
      if (r.t === "error") throw new Error(r.message);
      return r.attachment;
    } finally {
      ch.onclose = null;
      ch.close();
    }
  }

  /** Reads a file on the device over its own `file:<id>` channel. */
  async readFile(path: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array<ArrayBuffer>; modTime: number }> {
    if (!this.pc || this.snap.state !== "connected") throw new Error("Not connected to device");
    const ch = this.pc.createDataChannel(`${FILE_CHANNEL_PREFIX}${randomSid()}`, { ordered: true });
    ch.binaryType = "arraybuffer";
    try {
      return await new Promise((resolve, reject) => {
        let bytes: Uint8Array<ArrayBuffer> | null = null;
        let got = 0;
        let modTime = 0;
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        ch.onopen = () => ch.send(JSON.stringify({ t: "read", path } satisfies FileClientMsg));
        ch.onerror = () => reject(new Error("Couldn't open file channel"));
        ch.onclose = () => reject(new Error("File read interrupted"));
        ch.onmessage = (ev) => {
          if (ev.data instanceof ArrayBuffer) {
            if (!bytes) return;
            const chunk = new Uint8Array(ev.data);
            bytes.set(chunk.subarray(0, bytes.length - got), got);
            got += chunk.length;
            return;
          }
          let msg: FileDaemonMsg;
          try {
            msg = JSON.parse(ev.data as string) as FileDaemonMsg;
          } catch {
            return;
          }
          if (msg.t === "start") {
            bytes = new Uint8Array(msg.size);
            modTime = msg.modTime;
          } else if (msg.t === "end") {
            // The file may have shrunk while it was read.
            resolve({ bytes: (bytes ?? new Uint8Array()).subarray(0, got), modTime });
          } else {
            reject(new Error(msg.message));
          }
        };
      });
    } finally {
      ch.onclose = null;
      ch.close();
    }
  }

  /** Opens an `agent:<threadId>` channel for a claude thread. Throws if not connected. */
  openAgent(threadId: string, handlers: AgentHandlers): AgentChannel {
    if (!this.pc || this.snap.state !== "connected") throw new Error("Not connected to device");
    const ch = this.pc.createDataChannel(`${AGENT_CHANNEL_PREFIX}${threadId}`, { ordered: true });
    return new AgentChannel(ch, handlers);
  }

  /** Opens a `browser:<threadId>` channel to the thread's browser page. Throws if not connected. */
  openBrowser(threadId: string, handlers: BrowserHandlers): BrowserChannel {
    if (!this.pc || this.snap.state !== "connected") throw new Error("Not connected to device");
    const ch = this.pc.createDataChannel(`${BROWSER_CHANNEL_PREFIX}${threadId}`, { ordered: true });
    return new BrowserChannel(ch, handlers);
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

export interface AgentHandlers {
  onOpen(): void;
  onMessage(msg: AgentDaemonMsg): void;
  onClose(): void;
}

export class AgentChannel {
  private closed = false;

  constructor(
    private ch: RTCDataChannel,
    h: AgentHandlers,
  ) {
    ch.onopen = () => {
      if (!this.closed) h.onOpen();
    };
    ch.onmessage = (ev) => {
      if (this.closed || typeof ev.data !== "string") return;
      try {
        h.onMessage(JSON.parse(ev.data) as AgentDaemonMsg);
      } catch {
        // ignore malformed frames
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

  send(msg: AgentClientMsg): boolean {
    if (!this.isOpen) return false;
    this.ch.send(JSON.stringify(msg));
    return true;
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

/** Checks every open device connection (see DevicePeer.checkAlive). */
export function checkPeersAlive(): void {
  for (const p of peers.values()) p.checkAlive();
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
