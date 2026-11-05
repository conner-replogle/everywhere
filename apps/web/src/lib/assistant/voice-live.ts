// GPT-Live as the assistant's voice. The mic and GPT-Live's voice travel
// over WebRTC straight between this tab and OpenAI (the Worker only passes
// the offer and answer, with the account's key); GPT-Live's events come on
// the "oai-events" data channel. It holds the spoken conversation and hands
// work to the assistant's agent through LiveBridge.

import type { AssistantEntry } from "@everywhere/protocol";
import type { Message } from "@mariozechner/pi-ai";
import { api } from "@/lib/api";
import { assistantRunner, composePrompt } from "./agent";
import { watchStream } from "./levels";
import { type MicInfo, micInfo, openMic } from "./mic";
import { LiveBridge, type LiveEvent } from "./live-bridge";
import { messageText, spokenPart } from "./messages";
import { assistantSync, tabId } from "./sync";
import type { VoiceSnapshot } from "./voice";

/** Seed history: the newest this many prompts and replies, each cut to this length. */
const SEED_MESSAGES = 16;
const SEED_CHARS = 1500;
const ICE_GATHER_MS = 2000;
/** GPT-Live counts as speaking until this long after the last of its words. */
const SPEAKING_MS = 900;
/**
 * A session is billed the whole time it's open, quiet or not, and OpenAI
 * only closes it at its duration limit: close it after this long with
 * nothing said and nothing running.
 */
export const LIVE_IDLE_MS = 2 * 60 * 1000;
const IDLE_CHECK_MS = 10_000;
/** Recent GPT-Live events kept for bug reports. */
const DEBUG_EVENTS = 150;

const CLOSE_REASONS: Record<string, string> = {
  expired: "The voice session reached OpenAI's time limit. Tap the mic to start a new one.",
  content: "OpenAI's safety filter ended the voice session.",
  connection_lost: "The voice connection to OpenAI was lost.",
  remote_hangup: "OpenAI ended the voice session.",
};

/** What a bug report says about the voice session. */
export interface LiveDebug {
  sessionId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  closeReason: string | null;
  /** From session.usage.updated: seconds billed so far, and how full the context is. */
  usageSeconds: number | null;
  contextRatio: number | null;
  connectionState: string | null;
  iceConnectionState: string | null;
  /** The newest events, oldest first; transcript deltas are only counted. */
  events: { at: number; type: string; detail?: string }[];
  transcriptDeltas: number;
}

export const LIVE_INSTRUCTIONS = `You are the voice of the user's assistant in Everywhere, an app that runs terminals and Claude Code threads on all of their machines.

You can't see their devices, projects or threads, and you can't do anything on them yourself. A backend agent can: it reads threads, checks status, searches, and prompts or starts threads. Delegate every request that needs their devices, projects, threads, the web, or any action, and every question about what something is doing or did. Answer small talk and simple general questions yourself.

When results come back, say them plainly and briefly, in your own words. Don't invent thread names, statuses or results. When the backend asks to confirm an action, ask the user and wait for their answer; the app takes their yes or no.

Speak naturally and keep it short: a sentence or two, unless the user asks for more. No lists or markdown.`;

function seedHistory(entries: AssistantEntry[]): { role: "user" | "assistant"; text: string }[] {
  const out: { role: "user" | "assistant"; text: string }[] = [];
  for (const e of entries) {
    if (e.kind !== "message") continue;
    const m = e.message as Message;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = (m.role === "user" ? spokenPart(messageText(m)) : messageText(m)).trim();
    if (text) out.push({ role: m.role, text: text.slice(0, SEED_CHARS) });
  }
  return out.slice(-SEED_MESSAGES);
}

export class LiveVoice {
  private snap: VoiceSnapshot = { state: "off", heard: "", error: null };
  private listeners = new Set<() => void>();
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private bridge: LiveBridge | null = null;
  private unsubscribe: (() => void) | null = null;
  private speakingTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private lastActivity = 0;
  private dbg: LiveDebug = emptyDebug();
  private loggedTranscript = new Set<string>();
  private lastMic: MicInfo | null = null;

  getSnapshot = (): VoiceSnapshot => this.snap;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private update(patch: Partial<VoiceSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** The mic it's using, or used last. */
  mic(): MicInfo | null {
    return micInfo(this.stream) ?? this.lastMic;
  }

  debug(): LiveDebug {
    return {
      ...this.dbg,
      events: this.dbg.events.slice(),
      connectionState: this.pc?.connectionState ?? this.dbg.connectionState,
      iceConnectionState: this.pc?.iceConnectionState ?? this.dbg.iceConnectionState,
    };
  }

  private record(e: LiveEvent): void {
    if (e.type === "session.input_transcript.delta" || e.type === "session.output_transcript.delta") {
      // Only the first of each, to show it's coming.
      this.dbg.transcriptDeltas++;
      if (!this.loggedTranscript.has(e.type)) {
        this.loggedTranscript.add(e.type);
        console.info("GPT-Live:", e.type === "session.input_transcript.delta" ? "hearing you" : "speaking");
      }
      return;
    }
    if (e.type === "session.usage.updated") {
      const u = e as { usage?: { seconds?: number }; context_window?: { usage_ratio?: number } };
      this.dbg.usageSeconds = u.usage?.seconds ?? this.dbg.usageSeconds;
      this.dbg.contextRatio = u.context_window?.usage_ratio ?? this.dbg.contextRatio;
    }
    const detail =
      e.type === "session.closed" || e.type === "error" ? JSON.stringify(e).slice(0, 500) : typeof e.reason === "string" ? e.reason : undefined;
    this.dbg.events.push({ at: Date.now(), type: e.type, ...(detail ? { detail } : {}) });
    if (e.type !== "session.usage.updated") console.info("GPT-Live:", e.type, detail ?? "");
    if (this.dbg.events.length > DEBUG_EVENTS) this.dbg.events.splice(0, this.dbg.events.length - DEBUG_EVENTS);
  }

  /** Closes a session nobody is using. */
  private checkIdle(): void {
    const s = assistantSync.getSnapshot();
    if (s.runner || s.live?.approvals.length) this.lastActivity = Date.now();
    if (Date.now() - this.lastActivity < LIVE_IDLE_MS) return;
    this.stop();
    this.update({ error: "Voice turned off after two quiet minutes. Tap the mic to talk again." });
  }

  async start(): Promise<void> {
    if (this.snap.state !== "off") return;
    this.dbg = { ...emptyDebug(), startedAt: Date.now() };
    this.loggedTranscript.clear();
    this.update({ state: "starting", heard: "", error: null });
    try {
      this.stream = await openMic();
      this.lastMic = micInfo(this.stream);
      watchStream("mic", this.stream);
      const pc = new RTCPeerConnection();
      this.pc = pc;
      for (const t of this.stream.getAudioTracks()) pc.addTrack(t, this.stream);
      // srcObject isn't a URL, so the page's CSP (no blob: media) doesn't apply.
      const audio = new Audio();
      audio.autoplay = true;
      this.audio = audio;
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        audio.srcObject = stream;
        watchStream("out", stream);
        void audio.play().catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        this.dbg.events.push({ at: Date.now(), type: "pc.connectionstate", detail: pc.connectionState });
        if (pc.connectionState === "failed") this.fail("The voice connection dropped.");
      };
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      this.bridge = new LiveBridge(
        {
          ask: (text) => void assistantRunner.prompt(composePrompt(text, { voice: true })),
          approvals: () => {
            const live = assistantSync.getSnapshot().live;
            return live?.for === tabId ? live.approvals : [];
          },
          answer: (id, allow) => assistantRunner.answer(id, allow),
        },
        {
          send: (e) => {
            if (dc.readyState === "open") dc.send(JSON.stringify(e));
          },
          onStarted: () => this.update({ state: "listening" }),
          onHeard: (heard) => {
            this.lastActivity = Date.now();
            this.update({ heard });
          },
          onSaid: () => {
            this.lastActivity = Date.now();
            this.speaking();
          },
          onClosed: (reason) => {
            this.dbg.closeReason = reason;
            if (reason === "close_requested") this.stop();
            else this.fail(CLOSE_REASONS[reason] ?? `The voice session ended (${reason}).`);
          },
        },
      );
      dc.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const e = JSON.parse(ev.data) as LiveEvent;
          this.record(e);
          this.bridge?.handle(e);
        } catch {}
      };

      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      const answer = await api.startLive({
        sdp: pc.localDescription?.sdp ?? "",
        instructions: LIVE_INSTRUCTIONS,
        input: seedHistory(assistantSync.getSnapshot().entries),
      });
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      this.dbg.sessionId = answer.id;
      this.follow();
      this.lastActivity = Date.now();
      this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_MS);
    } catch (e) {
      const denied = e instanceof DOMException && e.name === "NotAllowedError";
      this.fail(denied ? "Microphone access was denied." : e instanceof Error ? e.message : String(e));
    }
  }

  /** What the agent says goes to GPT-Live to say; its approvals, to ask; the end of its turn, to close the hand-off. */
  private follow(): void {
    const s0 = assistantSync.getSnapshot();
    let lastSeq = s0.entries.at(-1)?.seq ?? 0;
    const asked = new Set(s0.live?.approvals.map((a) => a.id));
    let running = !!s0.runner;
    // Whether the turn answers this tab: only those replies are said here.
    let mine = s0.live?.for === tabId;
    this.unsubscribe = assistantSync.subscribe(() => {
      const s = assistantSync.getSnapshot();
      if (s.live) mine = s.live.for === tabId;
      for (const e of s.entries) {
        if (e.seq <= lastSeq) continue;
        lastSeq = e.seq;
        if (!mine || e.kind !== "message" || (e.message as Message).role !== "assistant") continue;
        const text = messageText(e.message as Message);
        if (text.trim()) this.bridge?.assistantSaid(text);
      }
      for (const a of s.live?.approvals ?? []) {
        if (asked.has(a.id) || !mine) continue;
        asked.add(a.id);
        this.bridge?.approvalAdded(a);
      }
      if (running && !s.runner) this.bridge?.turnEnded();
      running = !!s.runner;
    });
  }

  private speaking(): void {
    if (this.snap.state === "off" || this.snap.state === "starting") return;
    this.update({ state: "speaking" });
    clearTimeout(this.speakingTimer);
    this.speakingTimer = setTimeout(() => {
      if (this.snap.state === "speaking") this.update({ state: "listening" });
    }, SPEAKING_MS);
  }

  private fail(message: string): void {
    this.stop();
    this.update({ error: message });
  }

  stop(): void {
    clearTimeout(this.speakingTimer);
    clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    if (this.pc) {
      this.dbg.endedAt = Date.now();
      this.dbg.connectionState = this.pc.connectionState;
      this.dbg.iceConnectionState = this.pc.iceConnectionState;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.bridge?.close();
    this.bridge = null;
    try {
      if (this.dc?.readyState === "open") this.dc.send(JSON.stringify({ type: "session.close", event_id: "ew_close" }));
    } catch {}
    this.dc = null;
    this.pc?.close();
    this.pc = null;
    watchStream("mic", null);
    watchStream("out", null);
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    if (this.audio) this.audio.srcObject = null;
    this.audio = null;
    this.update({ state: "off", heard: "" });
  }
}

/** Resolves once the offer has its candidates (GPT-Live takes no trickled ones), or after a moment. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, ICE_GATHER_MS);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

function emptyDebug(): LiveDebug {
  return {
    sessionId: null,
    startedAt: null,
    endedAt: null,
    closeReason: null,
    usageSeconds: null,
    contextRatio: null,
    connectionState: null,
    iceConnectionState: null,
    events: [],
    transcriptDeltas: 0,
  };
}
