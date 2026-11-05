// Talking to the assistant: the microphone goes to the Worker's speech to
// text (Deepgram Flux, which also says when you've finished a turn), each
// finished turn becomes a prompt, and the replies are spoken (Aura) a
// sentence at a time as they stream. Talking over a reply stops it.

import type { AssistantListenMsg, AssistantLive } from "@everywhere/protocol";
import { useSyncExternalStore } from "react";
import { assistantRunner, composePrompt } from "./agent";
import { NO, speakable, YES } from "./messages";
import { outputAnalyser, watchStream } from "./levels";
import { voiceEngine } from "./voice-engine";
import { assistantSync } from "./sync";

export type VoiceState = "off" | "starting" | "listening" | "speaking";

export interface VoiceSnapshot {
  state: VoiceState;
  /** What the user is saying, before the turn ends. */
  heard: string;
  error: string | null;
  /** A note about the voice itself, e.g. that GPT-Live isn't set up. */
  notice?: string | null;
}

/** A sentence ends here, so it can be spoken before the rest arrives. */
const SENTENCE_END = /[.!?](?=\s|$)|\n/g;

class Speaker {
  private ctx: AudioContext | null = null;
  /** What's played goes through this, for the visualizer. */
  private out: AnalyserNode | null = null;
  private queue: Promise<AudioBuffer | null>[] = [];
  private playing: AudioBufferSourceNode | null = null;
  private generation = 0;
  private loop: Promise<void> | null = null;
  onActive: ((speaking: boolean) => void) | null = null;

  /** Must be called from a user gesture on iOS. */
  unlock(): void {
    this.ctx ??= new AudioContext();
    if (!this.out) {
      this.out = outputAnalyser(this.ctx);
      this.out.connect(this.ctx.destination);
    }
    void this.ctx.resume();
  }

  say(text: string): void {
    const t = speakable(text);
    if (!t || !this.ctx) return;
    const ctx = this.ctx;
    this.queue.push(
      fetch("/api/assistant/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t }),
      })
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`speak ${r.status}`))))
        .then((b) => ctx.decodeAudioData(b))
        .catch((e: unknown) => {
          console.warn("assistant speech:", e);
          return null;
        }),
    );
    this.loop ??= this.drain(this.generation);
  }

  private async drain(gen: number): Promise<void> {
    this.onActive?.(true);
    while (this.queue.length && gen === this.generation) {
      const buf = await this.queue.shift()!;
      if (!buf || gen !== this.generation || !this.ctx) continue;
      await new Promise<void>((resolve) => {
        const src = this.ctx!.createBufferSource();
        src.buffer = buf;
        src.connect(this.out ?? this.ctx!.destination);
        src.onended = () => resolve();
        this.playing = src;
        src.start();
      });
      this.playing = null;
    }
    if (gen === this.generation) {
      this.loop = null;
      this.onActive?.(false);
    }
  }

  get active(): boolean {
    return this.loop !== null;
  }

  /** Stops speaking and drops what was queued. */
  stop(): void {
    this.generation++;
    this.queue = [];
    try {
      this.playing?.stop();
    } catch {}
    this.playing = null;
    if (this.loop) {
      this.loop = null;
      this.onActive?.(false);
    }
  }

  close(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}

/** Workers AI as the voice: Flux listens, Aura speaks. */
class FluxVoice {
  private snap: VoiceSnapshot = { state: "off", heard: "", error: null };
  private listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private ws: WebSocket | null = null;
  private speaker = new Speaker();
  private unsubscribeLive: (() => void) | null = null;
  /** The reply being spoken: its text so far, and how much has been queued. */
  private reply = "";
  private spoken = 0;
  private announced = new Set<string>();

  constructor() {
    this.speaker.onActive = (speaking) => {
      if (this.snap.state !== "off" && this.snap.state !== "starting") {
        this.update({ state: speaking ? "speaking" : "listening" });
      }
    };
  }

  getSnapshot = (): VoiceSnapshot => this.snap;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private update(patch: Partial<VoiceSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  get on(): boolean {
    return this.snap.state !== "off";
  }

  toggle(): void {
    if (this.on) this.stop();
    else void this.start();
  }

  async start(): Promise<void> {
    if (this.on) return;
    this.update({ state: "starting", heard: "", error: null });
    this.speaker.unlock();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      watchStream("mic", this.stream);
      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule("/pcm-worklet.js");
      const source = this.ctx.createMediaStreamSource(this.stream);
      const pcm = new AudioWorkletNode(this.ctx, "pcm");
      source.connect(pcm);
      await this.connect(pcm);
    } catch (e) {
      this.stop();
      const denied = e instanceof DOMException && e.name === "NotAllowedError";
      this.update({ error: denied ? "Microphone access was denied." : e instanceof Error ? e.message : String(e) });
      return;
    }
    // Speak replies as they stream, whichever tab runs the turn.
    this.reply = assistantSync.getSnapshot().live?.text ?? "";
    this.spoken = this.reply.length;
    this.unsubscribeLive = assistantSync.subscribe(() => this.onLive(assistantSync.getSnapshot().live));
    this.update({ state: "listening" });
  }

  private connect(pcm: AudioWorkletNode): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/api/assistant/listen`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => {
        pcm.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
        };
        resolve();
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        try {
          this.onListen(JSON.parse(e.data) as AssistantListenMsg);
        } catch {}
      };
      ws.onerror = () => reject(new Error("Couldn't start listening."));
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (this.on) {
          this.stop();
          this.update({ error: "Listening stopped. Tap to talk again." });
        }
      };
    });
  }

  private onListen(m: AssistantListenMsg): void {
    if (m.t === "error") {
      this.update({ error: m.message });
      return;
    }
    switch (m.event) {
      case "StartOfTurn":
        // Talking over the reply stops it.
        this.speaker.stop();
        this.update({ heard: m.transcript });
        return;
      case "Update":
      case "TurnResumed":
      case "EagerEndOfTurn":
        this.update({ heard: m.transcript });
        return;
      case "EndOfTurn": {
        const text = m.transcript.trim();
        this.update({ heard: "" });
        if (text) this.onUtterance(text);
        return;
      }
    }
  }

  private onUtterance(text: string): void {
    const pending = assistantSync.getSnapshot().live?.approvals[0];
    if (pending) {
      if (YES.test(text)) return assistantRunner.answer(pending.id, true);
      assistantRunner.answer(pending.id, false);
      if (NO.test(text)) return;
    }
    void assistantRunner.prompt(composePrompt(text, { voice: true }));
  }

  /** Queues each finished sentence of the streaming reply, and asks about approvals. */
  private onLive(live: AssistantLive | null): void {
    const text = live?.text ?? "";
    if (!live || !text.startsWith(this.reply.slice(0, this.spoken))) {
      // The reply ended or a new one began: say the rest of the old one.
      this.say(this.reply.slice(this.spoken));
      this.reply = "";
      this.spoken = 0;
    }
    if (live) {
      this.reply = text;
      let end = -1;
      for (const m of text.slice(this.spoken).matchAll(SENTENCE_END)) end = m.index + 1;
      if (end > 0) {
        this.say(text.slice(this.spoken, this.spoken + end));
        this.spoken += end;
      }
      for (const a of live.approvals) {
        if (this.announced.has(a.id)) continue;
        this.announced.add(a.id);
        this.say(this.reply.slice(this.spoken));
        this.spoken = this.reply.length;
        this.speaker.say(`${a.title}. Should I?`);
      }
    }
  }

  private say(text: string): void {
    if (text.trim()) this.speaker.say(text);
  }

  stop(): void {
    watchStream("mic", null);
    this.unsubscribeLive?.();
    this.unsubscribeLive = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
    this.speaker.stop();
    this.reply = "";
    this.spoken = 0;
    this.update({ state: "off", heard: "" });
  }
}

interface Engine {
  getSnapshot(): VoiceSnapshot;
  subscribe(fn: () => void): () => void;
  start(): Promise<void>;
  stop(): void;
}

/**
 * The assistant's voice: GPT-Live when this browser prefers it and the
 * account has an OpenAI key, Workers AI otherwise. Picked each time it starts.
 */
class Voice {
  private flux = new FluxVoice();
  private live: Engine | null = null;
  private engine: Engine = this.flux;
  private off: (() => void) | null = null;
  private listeners = new Set<() => void>();
  /** Shown when GPT-Live was wanted but Workers AI is used. */
  private notice: string | null = null;
  private snap: VoiceSnapshot = this.flux.getSnapshot();

  getSnapshot = (): VoiceSnapshot => this.snap;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  get on(): boolean {
    return this.snap.state !== "off";
  }

  toggle(): void {
    if (this.on) this.stop();
    else void this.start();
  }

  async start(): Promise<void> {
    if (this.on) return;
    this.notice = null;
    let engine: Engine = this.flux;
    if (voiceEngine() === "live") {
      const available = await fetch("/api/assistant/live")
        .then((r) => (r.ok ? (r.json() as Promise<{ available?: boolean }>) : { available: false }))
        .then((r) => !!r.available, () => false);
      if (available) {
        if (!this.live) this.live = new (await import("./voice-live")).LiveVoice();
        engine = this.live;
      } else {
        this.notice = "GPT-Live isn't set up (Settings → Assistant), so this is the Workers AI voice.";
      }
    }
    this.use(engine);
    await engine.start();
  }

  stop(): void {
    this.engine.stop();
  }

  /** For bug reports: which voice ran last, and GPT-Live's session if it did. */
  debug(): { engine: "live" | "flux"; live: unknown } {
    const live = this.live as (Engine & { debug?: () => unknown }) | null;
    return { engine: this.engine === this.flux ? "flux" : "live", live: live?.debug?.() ?? null };
  }

  private use(engine: Engine): void {
    this.off?.();
    this.engine = engine;
    const sync = () => {
      const s = engine.getSnapshot();
      this.snap = { ...s, notice: s.state !== "off" ? this.notice : null };
      for (const fn of this.listeners) fn();
    };
    this.off = engine.subscribe(sync);
    sync();
  }
}

export const voice = new Voice();

export function useVoice(): VoiceSnapshot {
  return useSyncExternalStore(voice.subscribe, voice.getSnapshot);
}
