// Between GPT-Live and the assistant's agent. GPT-Live holds the spoken
// conversation: it answers some things itself and hands the rest off (a
// delegation) without saying what the work is. GPT-Live marks no turns:
// its transcripts come in pieces, each placed on the session's timeline
// (start_ms, end_ms), and a hand-off says where on it it happened
// (offset_ms). So the bridge keeps what you said and what it said as spans
// on that timeline:
// - A hand-off takes your words since GPT-Live last answered you, and gives
//   them to the agent. Words it already answered don't go along.
// - Words it answered itself (it spoke after them, and no hand-off came
//   within a few seconds) go to onAnswered with its reply, for the chat.
// - The agent's replies go back for GPT-Live to say; what happens in the
//   chat that GPT-Live didn't hear goes to it quietly (note).
// No browser APIs here: the voice controller (voice-live.ts) feeds it
// events and sends what it returns.

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
/** A hand-off takes the words heard up to this long after it (they're transcribed late). */
const DELEGATION_SLACK_MS = 1500;

export interface LiveAgent {
  /** The user's words, to run (or add to the running turn). */
  ask(text: string): void;
}

export type LiveEvent = { type: string; [k: string]: unknown };

export interface LiveBridgeHandlers {
  send(event: LiveEvent): void;
  /** What the user is saying, and what GPT-Live is saying, as they go. */
  onHeard?(text: string): void;
  onSaid?(text: string): void;
  /** GPT-Live answered the user itself: both sides, for the chat. */
  onAnswered?(said: string, reply: string): void;
  onStarted?(): void;
  onClosed?(reason: string): void;
}

/** Speech on the session's timeline, in ms. used: given to the agent or logged already. */
interface Span {
  text: string;
  start: number;
  end: number;
  used?: boolean;
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
        return this.h.onStarted?.();
      case "session.input_transcript.delta": {
        if (typeof e.delta !== "string") return;
        const span = this.add(this.you, e);
        this.lastHeardAt = this.now();
        this.h.onHeard?.(span.text.trim());
        this.checkAnswered();
        return;
      }
      case "session.output_transcript.delta": {
        if (typeof e.delta !== "string") return;
        const span = this.add(this.it, e);
        this.h.onSaid?.(span.text.trim());
        this.checkAnswered();
        return;
      }
      case "session.delegation.created": {
        const d = e.delegation as { id?: string; target?: string } | undefined;
        if (!d?.id) return;
        this.delegation = d.id;
        const at = typeof e.offset_ms === "number" ? e.offset_ms : this.timeline();
        this.settle(this.now(), at);
        return;
      }
      case "session.closed":
        this.flushAnswered(Infinity);
        return this.h.onClosed?.(typeof e.reason === "string" ? e.reason : "closed");
      case "error":
        console.warn("GPT-Live:", e);
        return;
    }
  }

  /** The agent said something: GPT-Live says it, as the result of the hand-off if there is one. */
  assistantSaid(text: string): void {
    const t = text.trim();
    for (let i = 0; i < t.length; i += APPEND_CHARS) this.append("session.commentary.append", t.slice(i, i + APPEND_CHARS));
  }

  /** Something happened in the conversation that GPT-Live didn't hear: it knows, without saying it. */
  note(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.h.send({ type: "session.thinking.append", event_id: `ew_${this.nextEvent++}`, delegation_id: null, content: t.slice(-APPEND_CHARS) });
  }

  /** The agent's turn is over: later replies aren't this hand-off's. */
  turnEnded(): void {
    this.delegation = null;
  }

  close(): void {
    clearTimeout(this.settleTimer);
    clearTimeout(this.answerTimer);
    this.flushAnswered(Infinity);
  }

  /** Where the session is on its timeline now. */
  private timeline(): number {
    return this.now() - this.t0;
  }

  /** Adds a transcript piece: to the last span if it follows closely, else as a new one. */
  private add(spans: Span[], e: LiveEvent): Span {
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
    spans.push(span);
    if (spans.length > 200) spans.splice(0, spans.length - 200);
    return span;
  }

  private append(type: string, content: string): void {
    if (!content.trim()) return;
    this.h.send({ type, event_id: `ew_${this.nextEvent++}`, delegation_id: this.delegation, content });
  }

  /** Waits for the transcript to stop growing, then hands the user's words to the agent. */
  private settle(since: number, at: number): void {
    clearTimeout(this.settleTimer);
    const quietFor = this.now() - this.lastHeardAt;
    const waited = this.now() - since;
    const open = this.you.filter((u) => !u.used);
    const settle = /[.?!]["')\]]?\s*$/.test(open.at(-1)?.text ?? "") ? DELEGATION_SETTLE_SENTENCE_MS : DELEGATION_SETTLE_MS;
    if (quietFor < settle && waited < DELEGATION_WAIT_MAX_MS) {
      this.settleTimer = setTimeout(() => this.settle(since, at), settle - quietFor);
      return;
    }
    // The words up to the hand-off; of those, only the ones since GPT-Live last answered.
    const mine = open.filter((u) => u.start <= at + DELEGATION_SLACK_MS);
    const last = mine.at(-1);
    const cutoff = last ? Math.max(-Infinity, ...this.it.filter((s) => s.end <= last.start).map((s) => s.end)) : -Infinity;
    this.flushAnswered(cutoff);
    const task = mine.filter((u) => !u.used && u.start >= cutoff);
    for (const u of mine) u.used = true;
    const text = task
      .map((u) => u.text.trim())
      .filter(Boolean)
      .join(" ");
    if (text) return this.agent.ask(text);
    // Nothing for the agent: tell GPT-Live quietly, so it doesn't wait on it.
    this.h.send({
      type: "session.thinking.append",
      event_id: `ew_${this.nextEvent++}`,
      delegation_id: this.delegation,
      content: "The app already handled that; there's nothing more to report.",
    });
    this.delegation = null;
  }

  /** Words GPT-Live answered itself go to the chat once no hand-off has come for them. */
  private checkAnswered(): void {
    clearTimeout(this.answerTimer);
    const lastSaid = this.it.at(-1);
    if (!lastSaid) return;
    const due = lastSaid.end + OWN_ANSWER_MS - this.timeline();
    if (due <= 0) return this.flushAnswered(lastSaid.end + 1);
    this.answerTimer = setTimeout(() => this.checkAnswered(), due);
  }

  /**
   * Logs each of the user's unused utterances that GPT-Live spoke after,
   * before `before` on the timeline, with what it said, then marks both used.
   */
  private flushAnswered(before: number): void {
    for (const u of this.you.filter((x) => !x.used && x.end < before)) {
      // What it said after these words, before the user spoke again.
      const next = this.you.find((x) => x.start > u.end)?.start ?? Infinity;
      const replies = this.it.filter((r) => !r.used && r.start >= u.start && r.start < next && r.start < before);
      if (!replies.length) continue;
      u.used = true;
      for (const r of replies) r.used = true;
      const reply = replies.map((r) => r.text.trim()).join(" ").trim();
      if (u.text.trim() && reply) this.h.onAnswered?.(u.text.trim(), reply);
    }
  }
}
