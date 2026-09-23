// Client state for one claude thread: the event log, the live state and the
// channel that feeds them. Survives reconnects: a new channel attaches with
// the last seen seq, so only missed events are replayed.

import type { AgentClientMsg, AgentDaemonMsg, AgentEvent, AgentState } from "@everywhere/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { AgentChannel, DevicePeer } from "./peer";

export interface LoggedEvent {
  seq: number;
  at: number;
  event: AgentEvent;
}

export interface AgentThreadSnapshot {
  events: LoggedEvent[];
  state: AgentState | null;
  /** The replay after attach has finished. */
  synced: boolean;
  /** Older events were left out of the replay. */
  truncated: boolean;
  /** The channel is open and attached. */
  attached: boolean;
  /** The channel closed while the device connection is still up. */
  closed: boolean;
  /** The daemon's last error for this client, until dismissed. */
  error: string | null;
}

class AgentThreadStore {
  private snap: AgentThreadSnapshot = {
    events: [],
    state: null,
    synced: false,
    truncated: false,
    attached: false,
    closed: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  private channel: AgentChannel | null = null;
  private lastSeq = 0;

  constructor(
    private peer: DevicePeer,
    private threadId: string,
  ) {}

  getSnapshot = (): AgentThreadSnapshot => this.snap;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<AgentThreadSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** Opens a channel and attaches after the last seen event. */
  connect(): void {
    this.disconnect();
    let ch: AgentChannel;
    try {
      ch = this.peer.openAgent(this.threadId, {
        onOpen: () => {
          ch.send({ t: "attach", afterSeq: this.lastSeq });
          this.set({ attached: true, closed: false, synced: false });
        },
        onMessage: (msg) => {
          if (this.channel === ch) this.onMessage(msg);
        },
        onClose: () => {
          if (this.channel === ch) this.set({ attached: false, closed: true });
        },
      });
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.channel = ch;
  }

  disconnect(): void {
    const ch = this.channel;
    this.channel = null;
    ch?.close();
    if (this.snap.attached) this.set({ attached: false });
  }

  send(msg: AgentClientMsg): void {
    if (!this.channel?.send(msg)) this.set({ error: "Not connected to this thread" });
  }

  dismissError(): void {
    this.set({ error: null });
  }

  private onMessage(msg: AgentDaemonMsg): void {
    switch (msg.t) {
      case "event": {
        if (msg.seq <= this.lastSeq) return;
        this.lastSeq = msg.seq;
        const ev = msg.event;
        let state = this.snap.state;
        // The completed block replaces its streamed preview.
        if (state && "streamKey" in ev && ev.streamKey) {
          const key = ev.streamKey;
          state = { ...state, streaming: state.streaming.filter((s) => s.key !== key) };
        }
        this.set({ events: [...this.snap.events, { seq: msg.seq, at: msg.at, event: ev }], state });
        return;
      }
      case "synced":
        this.set({ synced: true, truncated: this.snap.truncated || msg.truncated });
        return;
      case "state":
        this.set({ state: msg.state });
        return;
      case "delta": {
        const state = this.snap.state;
        if (!state) return;
        const i = state.streaming.findIndex((s) => s.key === msg.key);
        const streaming =
          i < 0
            ? [...state.streaming, { key: msg.key, kind: msg.kind, text: msg.text }]
            : state.streaming.map((s, j) => (j === i ? { ...s, text: s.text + msg.text } : s));
        this.set({ state: { ...state, streaming } });
        return;
      }
      case "error":
        this.set({ error: msg.message });
        return;
    }
  }
}

export interface AgentThread extends AgentThreadSnapshot {
  send: (msg: AgentClientMsg) => void;
  reconnect: () => void;
  dismissError: () => void;
}

/**
 * Attaches to a claude thread while mounted. Reattaches on every new device
 * connection (`generation`), keeping the events already received.
 */
export function useAgentThread(peer: DevicePeer, threadId: string, generation: number): AgentThread {
  const [store] = useState(() => new AgentThreadStore(peer, threadId));
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useEffect(() => {
    store.connect();
    return () => store.disconnect();
  }, [store, generation]);

  return {
    ...snap,
    send: (msg) => store.send(msg),
    reconnect: () => store.connect(),
    dismissError: () => store.dismissError(),
  };
}
