// GPT-Live as the assistant's voice. The mic and GPT-Live's voice travel
// over WebRTC straight between this tab and OpenAI (the Worker only passes
// the offer and answer, with the account's key); GPT-Live's events come on
// the "oai-events" data channel. It holds the spoken conversation and hands
// work to the assistant's agent through LiveBridge.

import type { AssistantEntry } from "@everywhere/protocol";
import type { Message } from "@mariozechner/pi-ai";
import { api } from "@/lib/api";
import { assistantRunner, composePrompt } from "./agent";
import { audioContext, closeAudio, isMobile } from "./audio";
import { loudness, watchStream } from "./levels";
import { type MicInfo, micInfo, openMic } from "./mic";
import { LiveBridge, type LiveEvent } from "./live-bridge";
import { clip, log, logWarn, since } from "./log";
import { fromVoice, messageText, spokenPart, voiceExchange } from "./messages";
import { assistantSync, tabId } from "./sync";
import type { VoiceSnapshot } from "./voice";

/** Seed history: the newest this many prompts and replies, each cut to this length. */
const SEED_MESSAGES = 16;
const SEED_CHARS = 1500;
const ICE_GATHER_MS = 2000;
/** GPT-Live counts as speaking until this long after the last of its words, or its voice went quiet. */
const SPEAKING_MS = 900;
/** How often its voice's loudness is checked, and above what it counts as speaking. */
const LEVEL_CHECK_MS = 100;
const SPEAKING_LEVEL = 0.04;
/** After session.close, how long to wait for session.closed (with the final usage) before hanging up anyway. */
const CLOSE_WAIT_MS = 15_000;
/** Say so this long before the session reaches OpenAI's time limit. */
const EXPIRY_WARN_MS = 60_000;
/** A request this tab asked that the log hasn't shown after this long isn't waited on. */
const ASK_STALE_MS = 60_000;
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
  /** When OpenAI ends the session (its time limit). */
  expiresAt: number | null;
  /** From session.usage.updated (and session.closed's final count): seconds billed so far, and how full the context is. */
  usageSeconds: number | null;
  contextRatio: number | null;
  connectionState: string | null;
  iceConnectionState: string | null;
  /** The newest events, oldest first; transcript deltas are only counted. */
  events: { at: number; type: string; detail?: string }[];
  transcriptDeltas: number;
}

// Laid out as OpenAI's prompting guide asks for gpt-live-1: its three policy
// headings, and "Generate <|SpawnThinking|>" for a hand-off.
export const LIVE_INSTRUCTIONS = `You are the voice of the user's assistant in Everywhere, an app that runs terminals and Claude Code threads on all of their machines.
Speak naturally and keep it short: a sentence or two, unless the user asks for more. No lists or markdown.
You can't see their devices, projects or threads, and you can't do anything on them yourself; the backend can.

Backchannel policy: Use few backchannels. Don't talk over the user.

Interruption policy: Stop speaking when the user interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- Threads: read what a Claude Code thread is doing or did, and its status.
- Devices and projects: list them, and what's running where.
- Prompts: draft a prompt for a thread on screen, ask if it's ready, and send it or start a new thread once the user says yes.
- Web: search and read pages.

Generate <|SpawnThinking|> when:
- The request needs their devices, projects, threads, the web, or any action.
- The user asks what something is doing or did.
- The user says anything about a draft: a change, an addition, a yes or a no.
- A correction changes work already requested.

Do not generate <|SpawnThinking|> when:
- It's small talk or a simple general question you can answer yourself.
- You can answer from the conversation or a result that's still current.
- You need a brief clarification to understand the request.

Generate <|SpawnThinking|> before giving an answer that depends on backend work.
Do not guess the result while waiting. Don't invent thread names, statuses or results.

When results come back, say them plainly and briefly, in your own words. Don't read a draft out; say what changed in a few words.`;

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
  private snap: VoiceSnapshot = { state: "off", heard: "", error: null, muted: false };
  private listeners = new Set<() => void>();
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private bridge: LiveBridge | null = null;
  private loggedMinute = -1;
  /**
   * Prompts this voice gave the agent, with when, until the log shows them:
   * they aren't told back to GPT-Live as news, and while one is waiting the
   * agent's replies answer an earlier request (the task's revision moved on).
   */
  private asked = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;
  private speakingTimer: ReturnType<typeof setTimeout> | undefined;
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
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
        log("live", e.type === "session.input_transcript.delta" ? "first words heard" : "first words spoken");
      }
      return;
    }
    if (e.type === "session.usage.updated" || e.type === "session.closed") {
      const u = e as { usage?: { seconds?: number }; context_window?: { usage_ratio?: number } };
      this.dbg.usageSeconds = u.usage?.seconds ?? this.dbg.usageSeconds;
      this.dbg.contextRatio = u.context_window?.usage_ratio ?? this.dbg.contextRatio;
    }
    const detail =
      e.type === "session.closed" || e.type === "error" ? JSON.stringify(e).slice(0, 500) : typeof e.reason === "string" ? e.reason : undefined;
    this.dbg.events.push({ at: Date.now(), type: e.type, ...(detail ? { detail } : {}) });
    if (e.type === "error") logWarn("live", "GPT-Live error", { event: e });
    else if (e.type !== "session.usage.updated") log("live", e.type, detail ? { detail } : undefined);
    else {
      // Once a minute: what's been billed.
      const minute = Math.floor((this.dbg.usageSeconds ?? 0) / 60);
      if (minute !== this.loggedMinute) {
        this.loggedMinute = minute;
        log("live", `billed ${Math.round(this.dbg.usageSeconds ?? 0)}s so far`, { contextUsed: this.dbg.contextRatio });
      }
    }
    if (this.dbg.events.length > DEBUG_EVENTS) this.dbg.events.splice(0, this.dbg.events.length - DEBUG_EVENTS);
  }

  /** Closes a session nobody is using. */
  private checkIdle(): void {
    const s = assistantSync.getSnapshot();
    if (s.runner) this.lastActivity = Date.now();
    if (Date.now() - this.lastActivity < LIVE_IDLE_MS) return;
    log("live", `closing: nothing said for ${LIVE_IDLE_MS / 60000} minutes`);
    this.stop();
    this.update({ error: "Voice turned off after two quiet minutes. Tap the mic to talk again." });
  }

  async start(): Promise<void> {
    if (this.snap.state !== "off") return;
    this.dbg = { ...emptyDebug(), startedAt: Date.now() };
    this.loggedTranscript.clear();
    this.update({ state: "starting", heard: "", error: null, muted: false });
    const t0 = Date.now();
    log("live", "starting a GPT-Live session");
    try {
      this.stream = await openMic();
      this.lastMic = micInfo(this.stream);
      log("live", `mic open after ${since(t0)}`, { mic: this.lastMic?.label, settings: this.lastMic?.settings });
      // The visualizer's context, made now that the mic is open.
      audioContext(true);
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
        // Feeding the call's audio into Web Audio crackles on phones (and can move it to the earpiece):
        // there the visualizer shows only the mic.
        if (!isMobile()) watchStream("out", stream);
        void audio.play().catch(() => {});
        clearInterval(this.levelTimer);
        this.levelTimer = setInterval(() => {
          if ((loudness("out") ?? 0) > SPEAKING_LEVEL) this.speaking();
        }, LEVEL_CHECK_MS);
      };
      pc.onconnectionstatechange = () => {
        this.dbg.events.push({ at: Date.now(), type: "pc.connectionstate", detail: pc.connectionState });
        (pc.connectionState === "failed" || pc.connectionState === "disconnected" ? logWarn : log)("live", `connection ${pc.connectionState}`);
        if (pc.connectionState === "failed") this.fail("The voice connection dropped.");
      };
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onopen = () => log("live", `event channel open after ${since(t0)}`);
      dc.onclose = () => log("live", "event channel closed");
      this.bridge = new LiveBridge(
        {
          ask: (text, call) => {
            const prompt = composePrompt(text, { voice: true, call });
            this.asked.set(prompt.trim(), Date.now());
            void assistantRunner.prompt(prompt);
          },
        },
        {
          send: (e) => {
            if (dc.readyState === "open") dc.send(JSON.stringify(e));
          },
          onStarted: (session) => {
            this.update({ state: "listening" });
            if (typeof session.expires_at === "number") this.warnBeforeExpiry(session.expires_at * 1000);
          },
          onHeard: (heard) => {
            if (this.snap.muted) return;
            this.lastActivity = Date.now();
            this.update({ heard });
          },
          onSaid: () => {
            this.lastActivity = Date.now();
            // Where its voice is measured, that says when it speaks; the transcript runs ahead of it.
            if (loudness("out") === null) this.speaking();
          },
          // What it answered itself goes in the conversation too, so the chat has the whole call.
          onAnswered: (said, reply) => {
            void assistantSync
              .append(voiceExchange(composePrompt(said, { voice: true }), reply).map((message) => ({ kind: "message" as const, message })))
              .catch((e: unknown) => logWarn("live", "couldn't log GPT-Live's own answer", { error: String(e), said: clip(said) }));
          },
          onClosed: (reason) => {
            this.dbg.closeReason = reason;
            if (reason === "close_requested") this.stop();
            else this.fail(CLOSE_REASONS[reason] ?? `The voice session ended (${reason}).`);
          },
        },
      );
      dc.onmessage = (ev) => this.onEvent(ev);

      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      log("live", `offer ready after ${since(t0)}: asking the Worker for a session`, { iceGathering: pc.iceGatheringState });
      const answer = await api.startLive({
        sdp: pc.localDescription?.sdp ?? "",
        instructions: LIVE_INSTRUCTIONS,
        input: seedHistory(assistantSync.getSnapshot().entries),
      });
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      this.dbg.sessionId = answer.id;
      log("live", `session ${answer.id} answered after ${since(t0)}`, { seedMessages: seedHistory(assistantSync.getSnapshot().entries).length });
      this.follow();
      this.lastActivity = Date.now();
      this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_MS);
    } catch (e) {
      const denied = e instanceof DOMException && e.name === "NotAllowedError";
      this.fail(denied ? "Microphone access was denied." : e instanceof Error ? e.message : String(e));
    }
  }

  /** What the agent says goes to GPT-Live to say; the end of its turn closes the hand-off. */
  private follow(): void {
    const s0 = assistantSync.getSnapshot();
    let lastSeq = s0.entries.at(-1)?.seq ?? 0;
    let running = !!s0.runner;
    // Whether the turn answers this tab: only those replies are said here.
    let mine = s0.live?.for === tabId;
    this.unsubscribe = assistantSync.subscribe(() => {
      const s = assistantSync.getSnapshot();
      if (s.live) mine = s.live.for === tabId;
      for (const e of s.entries) {
        if (e.seq <= lastSeq) continue;
        lastSeq = e.seq;
        if (e.kind !== "message" || fromVoice(e.message)) continue;
        const m = e.message as Message;
        const text = messageText(m).trim();
        if (!text) continue;
        if (m.role === "assistant") {
          // A reply to what was said here is said; one to something typed elsewhere, it just knows.
          // One that came while a newer request from here is waiting answers the older one: it's not said.
          if (mine && this.waiting()) {
            log("live", "a reply to an earlier request, before the latest reached the agent: not said", { text: clip(text) });
            this.bridge?.note(`An earlier reply, from before the user's latest words: ${text}`);
          } else if (mine) this.bridge?.assistantSaid(text);
          else this.bridge?.note(`Meanwhile the assistant replied in the chat: ${text}`);
        } else if (m.role === "user" && !this.asked.delete(text)) {
          const said = spokenPart(text);
          this.bridge?.note(said.startsWith("[Update]") ? said : `Meanwhile the user typed in the chat: ${said}`);
        }
      }
      if (running && !s.runner) this.bridge?.turnEnded();
      running = !!s.runner;
    });
  }

  /** Whether a request from here hasn't reached the log yet. */
  private waiting(): boolean {
    for (const [text, at] of this.asked) if (Date.now() - at > ASK_STALE_MS) this.asked.delete(text);
    return this.asked.size > 0;
  }

  private onEvent(ev: MessageEvent): void {
    if (typeof ev.data !== "string") return;
    let e: LiveEvent;
    try {
      e = JSON.parse(ev.data) as LiveEvent;
    } catch {
      return;
    }
    this.record(e);
    this.bridge?.handle(e);
  }

  private warnBeforeExpiry(at: number): void {
    this.dbg.expiresAt = at;
    log("live", `the session ends at OpenAI's time limit in ${Math.round((at - Date.now()) / 60000)} minutes`);
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(
      () => {
        if (this.snap.state !== "off") this.update({ notice: "The voice session reaches OpenAI's time limit in a minute." });
      },
      Math.max(0, at - Date.now() - EXPIRY_WARN_MS),
    );
  }

  /**
   * Pauses the mic (the session stays), or resumes it. A disabled track sends
   * silence over the call, so GPT-Live hears nothing. Muted time still counts
   * toward the idle close: the session is billed while it's open.
   */
  setMuted(muted: boolean): void {
    if (this.snap.state === "off" || this.snap.state === "starting" || muted === this.snap.muted) return;
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = !muted;
    log("live", muted ? "muted" : "unmuted");
    this.update({ muted, heard: "" });
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
    logWarn("live", `voice stopped: ${message}`);
    this.stop();
    this.update({ error: message });
  }

  stop(): void {
    clearTimeout(this.speakingTimer);
    clearInterval(this.levelTimer);
    clearTimeout(this.expiryTimer);
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
    this.hangUp();
    watchStream("mic", null);
    watchStream("out", null);
    closeAudio();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    if (this.audio) this.audio.srcObject = null;
    this.audio = null;
    this.update({ state: "off", heard: "", muted: false, notice: null });
  }

  /**
   * Ends the call. Asked to close, OpenAI finalizes the session and sends
   * session.closed with the final usage: the connection stays up (the mic is
   * already off) until it comes, or for CLOSE_WAIT_MS.
   */
  private hangUp(): void {
    const pc = this.pc;
    const dc = this.dc;
    this.pc = null;
    this.dc = null;
    if (!pc) return;
    // OpenAI already ended it, or there's no channel left to ask on.
    if (dc?.readyState !== "open" || this.dbg.closeReason) return pc.close();
    const dbg = this.dbg;
    const done = () => {
      clearTimeout(timer);
      dc.onmessage = null;
      pc.close();
    };
    const timer = setTimeout(() => {
      logWarn("live", `no session.closed ${CLOSE_WAIT_MS / 1000}s after asking to close: hanging up`);
      done();
    }, CLOSE_WAIT_MS);
    dc.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const e = JSON.parse(ev.data) as LiveEvent;
        if (e.type !== "session.closed" && e.type !== "session.usage.updated") return;
        // Not once a new session has started.
        if (this.dbg === dbg) this.record(e);
        if (e.type === "session.closed") {
          dbg.closeReason ??= typeof e.reason === "string" ? e.reason : null;
          done();
        }
      } catch {}
    };
    dc.onclose = done;
    pc.onconnectionstatechange = null;
    try {
      dc.send(JSON.stringify({ type: "session.close", event_id: "ew_close" }));
    } catch {
      done();
    }
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
    expiresAt: null,
    usageSeconds: null,
    contextRatio: null,
    connectionState: null,
    iceConnectionState: null,
    events: [],
    transcriptDeltas: 0,
  };
}
