// GPT-Live as the assistant's voice. The mic and GPT-Live's voice travel
// over WebRTC straight between this tab and OpenAI (the Worker only passes
// the offer and answer, with the account's key); GPT-Live's events come on
// the "oai-events" data channel. It holds the spoken conversation and hands
// work to the assistant's agent through LiveBridge.

import type { AssistantEntry } from "@everywhere/protocol";
import type { Message } from "@mariozechner/pi-ai";
import { api } from "@/lib/api";
import { assistantRunner, composePrompt } from "./agent";
import { LiveBridge, type LiveEvent } from "./live-bridge";
import { messageText, spokenPart } from "./messages";
import { assistantSync } from "./sync";
import type { VoiceSnapshot } from "./voice";

/** Seed history: the newest this many prompts and replies, each cut to this length. */
const SEED_MESSAGES = 16;
const SEED_CHARS = 1500;
const ICE_GATHER_MS = 2000;
/** GPT-Live counts as speaking until this long after the last of its words. */
const SPEAKING_MS = 900;

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

  getSnapshot = (): VoiceSnapshot => this.snap;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private update(patch: Partial<VoiceSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  async start(): Promise<void> {
    if (this.snap.state !== "off") return;
    this.update({ state: "starting", heard: "", error: null });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      const pc = new RTCPeerConnection();
      this.pc = pc;
      for (const t of this.stream.getAudioTracks()) pc.addTrack(t, this.stream);
      // srcObject isn't a URL, so the page's CSP (no blob: media) doesn't apply.
      const audio = new Audio();
      audio.autoplay = true;
      this.audio = audio;
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        void audio.play().catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") this.fail("The voice connection dropped.");
      };
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      this.bridge = new LiveBridge(
        {
          ask: (text) => void assistantRunner.prompt(composePrompt(text, { voice: true })),
          approvals: () => assistantSync.getSnapshot().live?.approvals ?? [],
          answer: (id, allow) => assistantRunner.answer(id, allow),
        },
        {
          send: (e) => {
            if (dc.readyState === "open") dc.send(JSON.stringify(e));
          },
          onStarted: () => this.update({ state: "listening" }),
          onHeard: (heard) => this.update({ heard }),
          onSaid: () => this.speaking(),
          onClosed: (reason) => (reason === "close_requested" ? this.stop() : this.fail(`The voice session ended (${reason}).`)),
        },
      );
      dc.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          this.bridge?.handle(JSON.parse(ev.data) as LiveEvent);
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
      this.follow();
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
    this.unsubscribe = assistantSync.subscribe(() => {
      const s = assistantSync.getSnapshot();
      for (const e of s.entries) {
        if (e.seq <= lastSeq) continue;
        lastSeq = e.seq;
        if (e.kind !== "message" || (e.message as Message).role !== "assistant") continue;
        const text = messageText(e.message as Message);
        if (text.trim()) this.bridge?.assistantSaid(text);
      }
      for (const a of s.live?.approvals ?? []) {
        if (asked.has(a.id)) continue;
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
