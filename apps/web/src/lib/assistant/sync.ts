// The assistant's conversation, as the Worker's Assistant DO keeps it: one
// WebSocket per tab that replays the log, receives what any tab adds, and
// says which tab is running a turn (the runner) and what that turn is doing.

import {
  type AssistantClientMsg,
  type AssistantEntry,
  type AssistantEntryData,
  type AssistantLive,
  type AssistantServerMsg,
  HUB_PING,
  HUB_PONG,
} from "@everywhere/protocol";
import { useSyncExternalStore } from "react";

export interface AssistantSnapshot {
  status: "idle" | "connecting" | "open" | "closed";
  /** The replay after (re)connecting has finished. */
  synced: boolean;
  /** Oldest first; from the latest compaction on, plus pages loaded earlier. */
  entries: AssistantEntry[];
  /** Older entries are on the server. */
  hasEarlier: boolean;
  /** This tab's connection id, and the one running a turn. */
  me: string | null;
  runner: string | null;
  /** What the running turn is doing (this tab's too). */
  live: AssistantLive | null;
}

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 15_000;
const REPLY_TIMEOUT_MS = 15_000;

/** This tab, for as long as it's open (connection ids change when it reconnects). */
export const tabId = crypto.randomUUID();

class AssistantSync {
  private ws: WebSocket | null = null;
  private running = false;
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private snap: AssistantSnapshot = {
    status: "idle",
    synced: false,
    entries: [],
    hasEarlier: false,
    me: null,
    runner: null,
    live: null,
  };
  private appends = new Map<string, { resolve: (seqs: number[]) => void; reject: (e: Error) => void }>();
  private claims: ((granted: boolean) => void)[] = [];
  private clearing: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private nextRef = 1;
  private loadingEarlier = false;
  /** The last seq the latest clear deleted: nothing before it is left to load. */
  private clearedThrough = 0;

  /** For the runner: prompts from other tabs. */
  onSteer: ((text: string, from: string | undefined) => void) | null = null;
  /** A steer found no runner; it's this tab's to handle. */
  onNoRunner: ((text: string) => void) | null = null;
  /** The conversation was cleared, from this tab or another. */
  onCleared: (() => void) | null = null;
  /** Another tab turned its mic on. */
  onVoiceElsewhere: (() => void) | null = null;

  getSnapshot = (): AssistantSnapshot => this.snap;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  get isRunner(): boolean {
    return !!this.snap.me && this.snap.runner === this.snap.me;
  }

  /** Adds entries to the log; resolves with their seqs. */
  append(entries: AssistantEntryData[]): Promise<number[]> {
    const ref = String(this.nextRef++);
    return new Promise((resolve, reject) => {
      if (!this.send({ t: "append", ref, entries })) return reject(new Error("not connected"));
      const timer = setTimeout(() => {
        this.appends.delete(ref);
        reject(new Error("the conversation didn't save"));
      }, REPLY_TIMEOUT_MS);
      this.appends.set(ref, {
        resolve: (seqs) => {
          clearTimeout(timer);
          resolve(seqs);
        },
        reject,
      });
    });
  }

  /** Becomes the runner if no other tab is; resolves with whether it did. */
  claim(): Promise<boolean> {
    if (this.isRunner) return Promise.resolve(true);
    return new Promise((resolve) => {
      if (!this.send({ t: "claim" })) return resolve(false);
      this.claims.push(resolve);
      setTimeout(() => {
        const i = this.claims.indexOf(resolve);
        if (i >= 0) this.claims.splice(i, 1)[0]?.(false);
      }, REPLY_TIMEOUT_MS);
    });
  }

  release(): void {
    if (this.isRunner) this.send({ t: "release" });
  }

  setLive(live: AssistantLive | null): void {
    this.update({ live });
    if (this.isRunner) this.send({ t: "live", live });
  }

  /** Sends a prompt to the tab running a turn. */
  steer(text: string): boolean {
    return this.send({ t: "steer", text, from: tabId });
  }

  /** This tab's mic is on: the others turn theirs off. */
  voiceOn(): void {
    this.send({ t: "voice", tab: tabId });
  }

  /** Deletes the whole conversation, for every tab; fails while a turn runs. */
  clear(): Promise<void> {
    if (this.clearing) return Promise.reject(new Error("Already clearing."));
    return new Promise((resolve, reject) => {
      if (!this.send({ t: "clear" })) return reject(new Error("Not connected to the conversation."));
      const timer = setTimeout(() => {
        this.clearing = null;
        reject(new Error("The conversation didn't answer."));
      }, REPLY_TIMEOUT_MS);
      this.clearing = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  loadEarlier(): void {
    const first = this.snap.entries[0];
    if (!first || this.loadingEarlier) return;
    this.loadingEarlier = this.send({ t: "history", beforeSeq: first.seq });
  }

  private send(msg: AssistantClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private update(patch: Partial<AssistantSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  private connect(): void {
    if (!this.running) return;
    this.update({ status: "connecting" });
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/assistant/ws`);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
      const last = this.snap.entries.at(-1);
      this.update({ status: "open", synced: false });
      this.send(last ? { t: "attach", afterSeq: last.seq } : { t: "attach" });
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== "string") return;
      if (ev.data === HUB_PONG) {
        clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
        return;
      }
      try {
        this.handle(JSON.parse(ev.data) as AssistantServerMsg);
      } catch (e) {
        console.warn("assistant message:", e);
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
      for (const a of this.appends.values()) a.reject(new Error("disconnected"));
      this.appends.clear();
      for (const c of this.claims.splice(0)) c(false);
      this.clearing?.reject(new Error("Disconnected from the conversation."));
      this.clearing = null;
      this.loadingEarlier = false;
      this.update({ status: "closed", synced: false, me: null, runner: null });
      if (!this.running) return;
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt++);
      this.retryTimer = setTimeout(() => this.connect(), delay * (0.5 + Math.random() / 2));
    };
  }

  /** Comes back to the foreground: make sure the socket is alive now. */
  checkAlive(): void {
    if (!this.running) return;
    if (this.ws?.readyState === WebSocket.OPEN) return this.ping();
    if (this.ws?.readyState === WebSocket.CONNECTING) return;
    clearTimeout(this.retryTimer);
    this.attempt = 0;
    this.connect();
  }

  private ping(): void {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN || this.pongTimer) return;
    ws.send(HUB_PING);
    this.pongTimer = setTimeout(() => {
      this.pongTimer = undefined;
      if (this.ws === ws) ws.close();
    }, PONG_TIMEOUT_MS);
  }

  private handle(m: AssistantServerMsg): void {
    switch (m.t) {
      case "hello": {
        // Cleared while this tab was away: what it has is gone.
        this.clearedThrough = m.clearedThrough;
        const entries = this.snap.entries.filter((e) => e.seq > m.clearedThrough);
        return this.update({ me: m.you, runner: m.runner, live: m.live, entries });
      }
      case "cleared":
        this.clearedThrough = m.throughSeq;
        this.update({ entries: this.snap.entries.filter((e) => e.seq > m.throughSeq), hasEarlier: false, live: null });
        this.clearing?.resolve();
        this.clearing = null;
        this.onCleared?.();
        return;
      case "entries": {
        const known = new Set(this.snap.entries.map((e) => e.seq));
        const add = m.entries.filter((e) => !known.has(e.seq));
        const entries = [...this.snap.entries, ...add].sort((a, b) => a.seq - b.seq);
        // A first replay that starts after the first seq still there has older entries behind it.
        const hasEarlier =
          m.initial && known.size === 0 ? (entries[0]?.seq ?? 1) > this.clearedThrough + 1 : this.snap.hasEarlier;
        return this.update({ entries, hasEarlier });
      }
      case "synced":
        return this.update({ synced: true });
      case "history": {
        this.loadingEarlier = false;
        const known = new Set(this.snap.entries.map((e) => e.seq));
        const entries = [...m.entries.filter((e) => !known.has(e.seq)), ...this.snap.entries];
        return this.update({ entries, hasEarlier: m.more });
      }
      case "appended":
        this.appends.get(m.ref)?.resolve(m.seqs);
        this.appends.delete(m.ref);
        return;
      case "runner": {
        const granted = !!m.runner && m.runner === this.snap.me;
        for (const c of this.claims.splice(0)) c(granted);
        return this.update({ runner: m.runner, ...(m.runner ? {} : { live: null }) });
      }
      case "live":
        if (!this.isRunner) this.update({ live: m.live });
        return;
      case "steer":
        return this.onSteer?.(m.text, m.from);
      case "voice":
        if (m.tab !== tabId) this.onVoiceElsewhere?.();
        return;
      case "noRunner":
        return this.onNoRunner?.(m.text);
      case "error":
        if (m.re === "clear" && this.clearing) {
          this.clearing.reject(new Error(m.message));
          this.clearing = null;
          return;
        }
        console.warn("assistant:", m.message);
        return;
    }
  }
}

export const assistantSync = new AssistantSync();

export function useAssistantSync(): AssistantSnapshot {
  return useSyncExternalStore(assistantSync.subscribe, assistantSync.getSnapshot);
}
