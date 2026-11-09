// Between GPT-Live and the assistant's agent. GPT-Live holds the spoken
// conversation: it answers some things itself and hands the rest off (a
// delegation) without saying what the work is. GPT-Live marks no turns:
// its transcripts come in pieces, each placed on the session's timeline
// (start_ms, end_ms), and a hand-off says where on it it happened
// (offset_ms). OpenAI's client delegation guide leaves the request to the
// app: it's in the conversation, and the notice can come before the words
// are transcribed. So the bridge keeps what you said and what it said as
// spans on that timeline:
// - A hand-off waits for the transcript to go quiet, then gives the agent
//   your words since GPT-Live last spoke before it, with the call since the
//   last request (both sides) as context. What it said after the hand-off
//   is its acknowledgement, never an answer.
// - Words it answered itself (it spoke after them, and no hand-off came
//   within a few seconds) go to onAnswered with its reply, for the chat.
// - The agent's replies go back for GPT-Live to say; what happens in the
//   chat that GPT-Live didn't hear goes to it quietly (note). Any thinking
//   or commentary cancels GPT-Live's pending spoken acknowledgement, so
//   notes wait while a hand-off settles.
// - Every update is matched to its acknowledgement (*.appended) or error,
//   so one GPT-Live didn't take is logged.
// No browser APIs here: the voice controller (voice-live.ts) feeds it
// events and sends what it returns.

import { clip, log, logWarn } from "./log";

/** GPT-Live takes at most 500 tokens per append; this stays well under. */
const APPEND_CHARS = 1500;
/** A hand-off can come before the transcript catches up; wait this long for it. */
export const DELEGATION_SETTLE_MS = 700;
/** Less when what's heard already ends a sentence: it's likely all there. */
export const DELEGATION_SETTLE_SENTENCE_MS = 300;
const DELEGATION_WAIT_MAX_MS = 3000;
/** Pieces of speech closer than this are one utterance. */
export const UTTERANCE_GAP_MS = 700;
/**
 * GPT-Live may say "let me check" before its hand-off: its words count as its
 * own answer only once this long has passed after them with no hand-off.
 */
export const OWN_ANSWER_MS = 4000;
/** Updates GPT-Live hasn't acknowledged after this long are logged. */
const ACK_WARN_MS = 10_000;

export interface LiveAgent {
  /** The user's words, to run (or add to the running turn); call: the call since the last request, when there's more than these words. */
  ask(text: string, call?: string): void;
}

export type LiveEvent = { type: string; [k: string]: unknown };

export interface LiveBridgeHandlers {
  send(event: LiveEvent): void;
  /** What the user is saying, and what GPT-Live is saying, as they go. */
  onHeard?(text: string): void;
  onSaid?(text: string): void;
  /** GPT-Live answered the user itself: both sides, for the chat. */
  onAnswered?(said: string, reply: string): void;
  onStarted?(session: { id?: string; expires_at?: number }): void;
  onClosed?(reason: string): void;
}

/** Speech on the session's timeline, in ms. used: given to the agent, logged, or GPT-Live's acknowledgement. */
interface Span {
  text: string;
  start: number;
  end: number;
  used?: boolean;
}

/** A hand-off waiting for the transcript to settle. */
interface Pending {
  since: number;
  at: number;
}

export class LiveBridge {
  /** What the user said, and what GPT-Live said, newest last. */
  private you: Span[] = [];
  private it: Span[] = [];
  /** When the session's timeline began, on this clock (for events without times). */
  private t0: number;
  private lastHeardAt = 0;
  /** The hand-off whose results go back with what the agent says. */
  private delegation: string | null = null;
  private seen = new Set<string>();
  private pending: Pending | null = null;
  /** Notes held while a hand-off settles. */
  private held: string[] = [];
  /** Updates sent and not yet acknowledged, by event_id. */
  private unacked = new Map<string, { type: string; content: string; at: number }>();
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private answerTimer: ReturnType<typeof setTimeout> | undefined;
  private nextEvent = 1;

  constructor(
    private agent: LiveAgent,
    private h: LiveBridgeHandlers,
    private now: () => number = Date.now,
  ) {
    this.t0 = now();
  }

  handle(e: LiveEvent): void {
    switch (e.type) {
      case "session.started":
        this.t0 = this.now();
        return this.h.onStarted?.((e.session as { id?: string; expires_at?: number } | undefined) ?? {});
      case "session.input_transcript.delta": {
        if (typeof e.delta !== "string") return;
        const span = this.add(this.you, e, "you");
        this.lastHeardAt = this.now();
        this.h.onHeard?.(span.text.trim());
        this.checkAnswered();
        return;
      }
      case "session.output_transcript.delta": {
        if (typeof e.delta !== "string") return;
        const span = this.add(this.it, e, "GPT-Live");
        this.h.onSaid?.(span.text.trim());
        this.checkAnswered();
        return;
      }
      case "session.delegation.created": {
        const d = e.delegation as { id?: string; target?: string } | undefined;
        if (!d?.id || (d.target && d.target !== "client")) return;
        if (this.seen.has(d.id)) return log("bridge", `hand-off ${d.id} again: already handled`);
        this.seen.add(d.id);
        const at = typeof e.offset_ms === "number" ? e.offset_ms : this.timeline();
        if (this.pending) log("bridge", `hand-off ${d.id} while ${this.delegation} settles: one request, answered on the new one`);
        else if (this.delegation) log("bridge", `hand-off ${d.id} while ${this.delegation} runs: later replies go to the new one`);
        this.delegation = d.id;
        log("bridge", `hand-off ${d.id} at ${(at / 1000).toFixed(1)}s`, { unusedUtterances: this.you.filter((u) => !u.used).length });
        this.pending = { since: this.pending?.since ?? this.now(), at: Math.max(at, this.pending?.at ?? 0) };
        this.settle();
        return;
      }
      case "session.thinking.appended":
      case "session.commentary.appended":
      case "session.instructions.appended":
        if (typeof e.client_event_id === "string") this.unacked.delete(e.client_event_id);
        this.warnUnacked();
        return;
      case "session.closed":
        log("bridge", "session closed", { reason: e.reason });
        this.flushAnswered(Infinity);
        return this.h.onClosed?.(typeof e.reason === "string" ? e.reason : "closed");
      case "error": {
        const err = e.error as { client_event_id?: string; message?: string } | undefined;
        const id = err?.client_event_id ?? (typeof e.client_event_id === "string" ? e.client_event_id : undefined);
        const update = id ? this.unacked.get(id) : undefined;
        if (id) this.unacked.delete(id);
        if (update) logWarn("bridge", `GPT-Live didn't take a ${update.type}: ${err?.message ?? "error"}`, { content: clip(update.content) });
        else logWarn("bridge", "GPT-Live sent an error", { event: e });
        return;
      }
    }
  }

  /** The agent said something: GPT-Live says it, as the result of the hand-off if there is one. */
  assistantSaid(text: string): void {
    const t = text.trim();
    log("bridge", `the agent's reply goes to GPT-Live to say (${t.length} chars)`, { delegation: this.delegation, text: clip(t) });
    for (let i = 0; i < t.length; i += APPEND_CHARS) this.append("session.commentary.append", this.delegation, t.slice(i, i + APPEND_CHARS));
  }

  /** Something happened in the conversation that GPT-Live didn't hear: it knows, without saying it. */
  note(text: string): void {
    const t = text.trim();
    if (!t) return;
    if (this.pending) {
      log("bridge", "a quiet note, held until the hand-off settles", { text: clip(t) });
      this.held.push(t);
      return;
    }
    log("bridge", "a quiet note to GPT-Live", { text: clip(t) });
    this.append("session.thinking.append", null, t.slice(-APPEND_CHARS));
  }

  /** The agent's turn is over: later replies aren't this hand-off's. */
  turnEnded(): void {
    if (this.pending) return;
    if (this.delegation) log("bridge", `the agent's turn ended: hand-off ${this.delegation} closed`);
    this.delegation = null;
  }

  close(): void {
    clearTimeout(this.settleTimer);
    clearTimeout(this.answerTimer);
    this.pending = null;
    this.flushAnswered(Infinity);
    if (this.unacked.size) logWarn("bridge", `${this.unacked.size} update(s) GPT-Live never acknowledged`, { types: [...this.unacked.values()].map((u) => u.type) });
  }

  /** Where the session is on its timeline now. */
  private timeline(): number {
    return this.now() - this.t0;
  }

  /** Adds a transcript piece: to the last span if it follows closely, else as a new one. */
  private add(spans: Span[], e: LiveEvent, who: string): Span {
    const delta = e.delta as string;
    const start = typeof e.start_ms === "number" ? e.start_ms : this.timeline();
    const end = typeof e.end_ms === "number" ? e.end_ms : start;
    const last = spans.at(-1);
    if (last && !last.used && start - last.end < UTTERANCE_GAP_MS) {
      last.text += delta;
      last.end = Math.max(last.end, end);
      return last;
    }
    const span = { text: delta, start, end };
    log("bridge", `${who} speaking at ${(start / 1000).toFixed(1)}s`);
    spans.push(span);
    // Kept in timeline order: pieces can arrive late.
    spans.sort((a, b) => a.start - b.start);
    if (spans.length > 200) spans.splice(0, spans.length - 200);
    return span;
  }

  private append(type: string, delegation: string | null, content: string): void {
    if (!content.trim()) return;
    const id = `ew_${this.nextEvent++}`;
    this.unacked.set(id, { type, content, at: this.now() });
    this.h.send({ type, event_id: id, delegation_id: delegation, content });
  }

  private warnUnacked(): void {
    for (const [id, u] of this.unacked) {
      if (this.now() - u.at < ACK_WARN_MS) continue;
      logWarn("bridge", `GPT-Live hasn't acknowledged a ${u.type} after ${ACK_WARN_MS / 1000}s`, { content: clip(u.content) });
      this.unacked.delete(id);
    }
  }

  /** Waits for the transcript to stop growing, then hands the user's words to the agent. */
  private settle(): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(this.settleTimer);
    const quietFor = this.now() - this.lastHeardAt;
    const waited = this.now() - p.since;
    const heard = this.you.filter((u) => !u.used);
    const settle = /[.?!]["')\]]?\s*$/.test(heard.at(-1)?.text ?? "") ? DELEGATION_SETTLE_SENTENCE_MS : DELEGATION_SETTLE_MS;
    if (quietFor < settle && waited < DELEGATION_WAIT_MAX_MS) {
      if (!waited) log("bridge", `waiting for the transcript to settle (${settle} ms quiet)`);
      this.settleTimer = setTimeout(() => this.settle(), settle - quietFor);
      return;
    }
    this.pending = null;
    // GPT-Live's last words before the hand-off that you spoke after: what you said before them, it answered.
    // What it said after your last words is its acknowledgement.
    const open = this.you.filter((u) => !u.used);
    const cutoff = Math.max(-Infinity, ...this.it.filter((s) => !s.used && s.end <= p.at && open.some((u) => u.start >= s.end)).map((s) => s.end));
    const answered = this.flushAnswered(cutoff);
    const task = this.you.filter((u) => !u.used);
    for (const u of task) u.used = true;
    // What it says from the hand-off on acknowledges it.
    for (const s of this.it) if (!s.used && s.start >= cutoff) s.used = true;
    const text = task
      .map((u) => u.text.trim())
      .filter(Boolean)
      .join(" ");
    const call = answered.map(([said, reply]) => `You: ${said}\nGPT-Live: ${reply}`).join("\n");
    log("bridge", text ? "hand-off: the agent gets" : "hand-off with nothing new heard", {
      text: clip(text, 300),
      waitedMs: waited,
      answeredBefore: cutoff === -Infinity ? null : `${(cutoff / 1000).toFixed(1)}s`,
      answeredItself: answered.length,
    });
    if (text) this.agent.ask(text, call ? `${call}\nYou: ${text}` : undefined);
    else {
      // Nothing for the agent: tell GPT-Live quietly, so it doesn't wait on it.
      this.append("session.thinking.append", this.delegation, "The app already handled that; there's nothing more to report.");
      this.delegation = null;
    }
    for (const t of this.held.splice(0)) this.note(t);
    this.checkAnswered();
  }

  /** Words GPT-Live answered itself go to the chat once no hand-off has come for them. */
  private checkAnswered(): void {
    clearTimeout(this.answerTimer);
    if (this.pending) return;
    const lastSaid = this.it.filter((s) => !s.used).at(-1);
    if (!lastSaid) return;
    const due = lastSaid.end + OWN_ANSWER_MS - this.timeline();
    if (due <= 0) return void this.flushAnswered(lastSaid.end + 1);
    this.answerTimer = setTimeout(() => this.checkAnswered(), due);
  }

  /**
   * Logs the user's unused words that GPT-Live spoke after, before `before`
   * on the timeline, with what it said, then marks both used. Words said one
   * after another before it replied go together. Returns the exchanges.
   */
  private flushAnswered(before: number): [string, string][] {
    const timeline = [
      ...this.you.filter((s) => !s.used && s.end < before).map((s) => ({ s, mine: true })),
      ...this.it.filter((s) => !s.used && s.start < before).map((s) => ({ s, mine: false })),
    ].sort((a, b) => a.s.start - b.s.start);
    const out: [string, string][] = [];
    let said: Span[] = [];
    let reply: Span[] = [];
    const emit = () => {
      if (said.length && reply.length) {
        for (const x of [...said, ...reply]) x.used = true;
        const a = said.map((x) => x.text.trim()).filter(Boolean).join(" ");
        const b = reply.map((x) => x.text.trim()).filter(Boolean).join(" ");
        if (a && b) {
          log("bridge", "GPT-Live answered this itself: logging it", { said: clip(a), reply: clip(b) });
          this.h.onAnswered?.(a, b);
          out.push([a, b]);
        }
      }
      said = [];
      reply = [];
    };
    for (const { s, mine } of timeline) {
      if (mine && reply.length) emit();
      // What it says before you've said anything here isn't an answer.
      if (mine) said.push(s);
      else if (said.length) reply.push(s);
    }
    emit();
    return out;
  }
}
