// Client state for one claude thread: the event log, the live state and the
// channel that feeds them. Survives reconnects and, through a small cache,
// leaving and reopening the thread: a new channel attaches with the last seen
// seq, so only missed events are replayed.

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
  /** The device has older events than the ones loaded. */
  truncated: boolean;
  /** A page of older events was asked for and hasn't arrived. */
  loadingEarlier: boolean;
  /** The channel is open and attached. */
  attached: boolean;
  /** The channel closed while the device connection is still up. */
  closed: boolean;
  /** The daemon's last error for this client, until dismissed. */
  error: string | null;
}

/** Events replayed on a thread's first open; older ones load in pages. */
const FIRST_PAGE = 300;
const EARLIER_PAGE = 500;

class AgentThreadStore {
  private snap: AgentThreadSnapshot = {
    events: [],
    state: null,
    synced: false,
    truncated: false,
    loadingEarlier: false,
    attached: false,
    closed: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  private channel: AgentChannel | null = null;
  private lastSeq = 0;
  /** Events replayed since attach, shown all at once on `synced`. */
  private replay: LoggedEvent[] | null = null;
  /** lastSeq when the current replay began. */
  private replayFrom = 0;

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
          this.replay = [];
          this.replayFrom = this.lastSeq;
          // Catching up after a reconnect takes everything missed, up to the daemon's cap.
          ch.send(this.lastSeq ? { t: "attach", afterSeq: this.lastSeq } : { t: "attach", limit: FIRST_PAGE });
          this.set({ attached: true, closed: false, synced: false, loadingEarlier: false });
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
    // Keep what a cut-short replay delivered: lastSeq already counts it.
    const replay = this.replay;
    this.replay = null;
    if (replay?.length) this.set({ events: [...this.snap.events, ...replay] });
    if (this.snap.attached) this.set({ attached: false });
  }

  send(msg: AgentClientMsg): void {
    if (!this.channel?.send(msg)) this.set({ error: "Not connected to this thread" });
  }

  /** Asks the daemon for the page of events before the oldest one loaded. */
  loadEarlier(): void {
    const first = this.snap.events[0]?.seq;
    if (!first || !this.snap.truncated || this.snap.loadingEarlier || !this.snap.synced) return;
    if (!this.channel?.send({ t: "history", beforeSeq: first, limit: EARLIER_PAGE })) return;
    this.set({ loadingEarlier: true });
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
        const logged = { seq: msg.seq, at: msg.at, event: ev };
        // Rendering per replayed event would redraw the timeline thousands of times.
        if (this.replay) {
          this.replay.push(logged);
          return;
        }
        let state = this.snap.state;
        // The completed block replaces its streamed preview.
        if (state && "streamKey" in ev && ev.streamKey) {
          const key = ev.streamKey;
          state = { ...state, streaming: state.streaming.filter((s) => s.key !== key) };
        }
        this.set({ events: [...this.snap.events, logged], state });
        return;
      }
      case "synced": {
        const replay = this.replay ?? [];
        this.replay = null;
        // Too much was missed to fill the gap: start over from the newest events.
        const gap = msg.truncated && this.replayFrom > 0;
        this.set({
          events: gap ? replay : replay.length ? [...this.snap.events, ...replay] : this.snap.events,
          synced: true,
          truncated: gap || this.snap.truncated || msg.truncated,
        });
        return;
      }
      case "history": {
        const first = this.snap.events[0]?.seq ?? Number.POSITIVE_INFINITY;
        const older = msg.events.filter((e) => e.seq < first);
        this.set({ events: [...older, ...this.snap.events], truncated: msg.more, loadingEarlier: false });
        return;
      }
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
  loadEarlier: () => void;
  dismissError: () => void;
}

// Recently opened threads keep their events, so reopening one shows it at
// once and only fetches what happened since.
const CACHED_THREADS = 20;
const cache = new WeakMap<DevicePeer, Map<string, AgentThreadStore>>();

function threadStore(peer: DevicePeer, threadId: string): AgentThreadStore {
  let stores = cache.get(peer);
  if (!stores) cache.set(peer, (stores = new Map()));
  let store = stores.get(threadId);
  // Map order is insertion order: re-inserting marks it most recently used.
  if (store) stores.delete(threadId);
  else store = new AgentThreadStore(peer, threadId);
  stores.set(threadId, store);
  for (const id of stores.keys()) {
    if (stores.size <= CACHED_THREADS) break;
    stores.delete(id);
  }
  return store;
}

/**
 * Attaches to a claude thread while mounted. Reattaches on every new device
 * connection (`generation`), keeping the events already received.
 */
export function useAgentThread(peer: DevicePeer, threadId: string, generation: number): AgentThread {
  const [store] = useState(() => threadStore(peer, threadId));
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useEffect(() => {
    store.connect();
    return () => store.disconnect();
  }, [store, generation]);

  return {
    ...snap,
    send: (msg) => store.send(msg),
    reconnect: () => store.connect(),
    loadEarlier: () => store.loadEarlier(),
    dismissError: () => store.dismissError(),
  };
}
