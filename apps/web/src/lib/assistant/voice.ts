// Talking to the assistant: the microphone goes to the Worker's speech to
// text (Deepgram Flux, which also says when you've finished a turn), each
// finished turn becomes a prompt, and the replies are spoken (Aura) a
// sentence at a time as they stream. Talking over a reply stops it.

import type { AssistantListenMsg, AssistantLive } from "@everywhere/protocol";
import { useSyncExternalStore } from "react";
import { assistantRunner, composePrompt } from "./agent";
import { speakable } from "./messages";
import { audioContext, audioInfo, closeAudio, isMobile } from "./audio";
import { clearOutput, outputAnalyser, watchStream } from "./levels";
import { clip, log, logWarn, since } from "./log";
import { type MicInfo, micDeviceId, micInfo, openMic } from "./mic";
import { voiceEngine } from "./voice-engine";
import { assistantSync, tabId } from "./sync";

export type VoiceState = "off" | "starting" | "listening" | "speaking";

export interface VoiceSnapshot {
  state: VoiceState;
  /** What the user is saying, before the turn ends. */
  heard: string;
  error: string | null;
  /** The mic is muted: nothing is captured, sent or heard until it's unmuted. */
  muted: boolean;
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

  /** Plays through the voice's context (audio.ts), given once the mic is open. */
  attach(ctx: AudioContext): void {
    this.ctx = ctx;
    this.out = outputAnalyser(ctx);
    this.out.connect(ctx.destination);
  }

  say(text: string): void {
    const t = speakable(text);
    if (!t || !this.ctx) return;
    const ctx = this.ctx;
    const at = Date.now();
    log("voice", "speaking a sentence: asking Aura", { text: clip(t, 80), queued: this.queue.length });
    this.queue.push(
      fetch("/api/assistant/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t }),
      })
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`speak ${r.status}`))))
        .then((b) => ctx.decodeAudioData(b))
        .then((buf) => {
          log("voice", `Aura's audio ready after ${since(at)}`, { seconds: +buf.duration.toFixed(1), text: clip(t, 40) });
          return buf;
        })
        .catch((e: unknown) => {
          logWarn("voice", `Aura failed after ${since(at)}`, { error: String(e), text: clip(t, 80) });
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
    if (this.loop) log("voice", "stopped speaking", { dropped: this.queue.length });
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

  /** Lets go of the context; the voice closes it. */
  detach(): void {
    this.stop();
    if (this.out) {
      this.out.disconnect();
      clearOutput(this.out);
    }
    this.out = null;
    this.ctx = null;
  }
}

/** Workers AI as the voice: Flux listens, Aura speaks. */
class FluxVoice {
  private lastMic: MicInfo | null = null;
  private snap: VoiceSnapshot = { state: "off", heard: "", error: null, muted: false };
  private listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private ws: WebSocket | null = null;
  private speaker = new Speaker();
  private unsubscribeLive: (() => void) | null = null;
  /** The reply being spoken: its text so far, and how much has been queued. */
  private reply = "";
  private spoken = 0;

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

  mic(): MicInfo | null {
    return micInfo(this.stream) ?? this.lastMic;
  }

  toggle(): void {
    if (this.on) this.stop();
    else void this.start();
  }

  async start(): Promise<void> {
    if (this.on) return;
    this.update({ state: "starting", heard: "", error: null, muted: false });
    const t0 = Date.now();
    log("voice", "starting the Workers AI voice");
    try {
      this.stream = await openMic();
      this.lastMic = micInfo(this.stream);
      log("voice", `mic open after ${since(t0)}`, { mic: this.lastMic?.label, settings: this.lastMic?.settings });
      // One context for capture, speech and the visualizer, made now that the mic is open.
      this.ctx = audioContext(true);
      this.speaker.attach(this.ctx);
      watchStream("mic", this.stream);
      await this.ctx.audioWorklet.addModule("/pcm-worklet.js");
      const source = this.ctx.createMediaStreamSource(this.stream);
      const pcm = new AudioWorkletNode(this.ctx, "pcm");
      source.connect(pcm);
      await this.connect(pcm);
      log("voice", `listening after ${since(t0)}`);
    } catch (e) {
      logWarn("voice", "couldn't start the Workers AI voice", { error: String(e) });
      this.stop();
      const denied = e instanceof DOMException && e.name === "NotAllowedError";
      this.update({ error: denied ? "Microphone access was denied." : e instanceof Error ? e.message : String(e) });
      return;
    }
    // Speak replies to what was said here as they stream, whichever tab runs the turn.
    this.reply = ours(assistantSync.getSnapshot().live)?.text ?? "";
    this.spoken = this.reply.length;
    this.unsubscribeLive = assistantSync.subscribe(() => this.onLive(ours(assistantSync.getSnapshot().live)));
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
          // Muted, silence goes instead (the track is off too): Flux closes a socket that gets no audio.
          if (ws.readyState === WebSocket.OPEN) ws.send(this.snap.muted ? new ArrayBuffer(e.data.byteLength) : e.data);
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
          logWarn("voice", "the speech-to-text socket closed");
          this.stop();
          this.update({ error: "Listening stopped. Tap to talk again." });
        }
      };
    });
  }

  private onListen(m: AssistantListenMsg): void {
    if (m.t === "error") {
      logWarn("voice", `speech to text: ${m.message}`);
      this.update({ error: m.message });
      return;
    }
    // Muted: nothing is heard, not even the end of a turn begun before.
    if (this.snap.muted) return;
    switch (m.event) {
      case "StartOfTurn":
        log("voice", this.speaker.active ? "you started talking: interrupting the reply" : "you started talking");
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
        log("voice", text ? "you finished: prompting the agent" : "you finished, but nothing was heard", { text: clip(text) });
        this.update({ heard: "" });
        if (text) this.onUtterance(text);
        return;
      }
    }
  }

  /** Pauses the mic (the session stays), or resumes it. */
  setMuted(muted: boolean): void {
    if (this.snap.state === "off" || this.snap.state === "starting" || muted === this.snap.muted) return;
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = !muted;
    log("voice", muted ? "muted" : "unmuted");
    this.update({ muted, heard: "" });
  }

  private onUtterance(text: string): void {
    void assistantRunner.prompt(composePrompt(text, { voice: true }));
  }

  /** Queues each finished sentence of the streaming reply. */
  private onLive(live: AssistantLive | null): void {
    const text = live?.text ?? "";
    // Ended (no live state, or the text cleared once it was logged) or a new reply began.
    if (!live || text.length < this.reply.length || !text.startsWith(this.reply.slice(0, this.spoken))) {
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
    this.speaker.detach();
    this.ctx = null;
    closeAudio();
    this.reply = "";
    this.spoken = 0;
    this.update({ state: "off", heard: "", muted: false });
  }
}

/** The running turn's live state if it answers this tab; replies to other tabs aren't spoken here. */
export function ours(live: AssistantLive | null): AssistantLive | null {
  return live?.for === tabId ? live : null;
}

interface Engine {
  /** The mic it's using, or used last. */
  mic(): MicInfo | null;
  getSnapshot(): VoiceSnapshot;
  subscribe(fn: () => void): () => void;
  start(): Promise<void>;
  stop(): void;
  setMuted(muted: boolean): void;
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
  /** Why it stopped, when another tab's mic took over. */
  private movedAway: string | null = null;

  constructor() {
    // One mic at a time: turning it on in another tab or device turns it off here.
    assistantSync.onVoiceElsewhere = () => {
      if (!this.on) return;
      log("voice", "another tab's mic took over: turning this one off");
      this.engine.stop();
      this.movedAway = "Voice moved to another window or device.";
      this.emit();
    };
  }
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

  toggleMute(): void {
    this.engine.setMuted(!this.snap.muted);
  }

  async start(): Promise<void> {
    if (this.on) return;
    this.notice = null;
    this.movedAway = null;
    let engine: Engine = this.flux;
    if (voiceEngine() === "live") {
      const available = await fetch("/api/assistant/live")
        .then((r) => (r.ok ? (r.json() as Promise<{ available?: boolean }>) : { available: false }))
        .then((r) => !!r.available, () => false);
      if (available) {
        if (!this.live) this.live = new (await import("./voice-live")).LiveVoice();
        engine = this.live;
      } else {
        log("voice", "GPT-Live is wanted but not set up: using Workers AI");
        this.notice = "GPT-Live isn't set up (Settings → Assistant), so this is the Workers AI voice.";
      }
    }
    this.use(engine);
    log("voice", `voice on: ${engine === this.flux ? "Workers AI (Flux + Aura)" : "GPT-Live"}`);
    await engine.start();
    if (this.on) assistantSync.voiceOn();
  }

  stop(): void {
    log("voice", "voice off");
    this.engine.stop();
  }

  /** For bug reports: which voice ran last, and GPT-Live's session if it did. */
  debug(): { engine: "live" | "flux"; chosenMic: string; mic: MicInfo | null; audio: unknown; live: unknown } {
    const live = this.live as (Engine & { debug?: () => unknown }) | null;
    return {
      engine: this.engine === this.flux ? "flux" : "live",
      // "" is the system default.
      chosenMic: micDeviceId(),
      mic: this.engine.mic(),
      audio: { mobile: isMobile(), context: audioInfo() },
      live: live?.debug?.() ?? null,
    };
  }

  private use(engine: Engine): void {
    this.off?.();
    this.engine = engine;
    this.off = engine.subscribe(() => this.emit());
    this.emit();
  }

  private emit(): void {
    const s = this.engine.getSnapshot();
    this.snap = { ...s, error: s.error ?? (s.state === "off" ? this.movedAway : null), notice: s.state !== "off" ? (s.notice ?? this.notice) : null };
    for (const fn of this.listeners) fn();
  }
}

export const voice = new Voice();

export function useVoice(): VoiceSnapshot {
  return useSyncExternalStore(voice.subscribe, voice.getSnapshot);
}
