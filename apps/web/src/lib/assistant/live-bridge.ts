// Between GPT-Live and the assistant's agent. GPT-Live holds the spoken
// conversation and, when there's work, hands it off (a delegation) without
// saying what the work is: the bridge takes what the user said since the
// last hand-off from GPT-Live's transcript, gives it to the agent, and hands
// the agent's replies back for GPT-Live to say. No browser APIs here: the voice
// controller (voice-live.ts) feeds it events and sends what it returns.

/** GPT-Live takes at most 500 tokens per append; this stays well under. */
const APPEND_CHARS = 1500;
/** A hand-off can come before the transcript catches up; wait this long for it. */
export const DELEGATION_SETTLE_MS = 700;
/** Less when what's heard already ends a sentence: it's likely all there. */
export const DELEGATION_SETTLE_SENTENCE_MS = 300;
const DELEGATION_WAIT_MAX_MS = 3000;

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
  onStarted?(): void;
  onClosed?(reason: string): void;
}

export class LiveBridge {
  /** What the user has said since it was last given to the agent. */
  private heard = "";
  private lastHeardAt = 0;
  private said = "";
  /** The hand-off whose results go back with what the agent says. */
  private delegation: string | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private nextEvent = 1;

  constructor(
    private agent: LiveAgent,
    private h: LiveBridgeHandlers,
    private now: () => number = Date.now,
  ) {}

  handle(e: LiveEvent): void {
    switch (e.type) {
      case "session.started":
        return this.h.onStarted?.();
      case "session.input_transcript.delta":
        if (typeof e.delta !== "string") return;
        this.heard += e.delta;
        this.lastHeardAt = this.now();
        this.h.onHeard?.(this.heard.trim());
        return;
      case "session.output_transcript.delta":
        if (typeof e.delta !== "string") return;
        this.said += e.delta;
        this.h.onSaid?.(this.said.trim());
        return;
      case "session.delegation.created": {
        const d = e.delegation as { id?: string; target?: string } | undefined;
        if (!d?.id) return;
        this.delegation = d.id;
        this.said = "";
        this.settle(this.now());
        return;
      }
      case "session.closed":
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

  /** The agent's turn is over: later replies aren't this hand-off's. */
  turnEnded(): void {
    this.delegation = null;
  }

  close(): void {
    clearTimeout(this.settleTimer);
  }

  private append(type: string, content: string): void {
    if (!content.trim()) return;
    this.h.send({ type, event_id: `ew_${this.nextEvent++}`, delegation_id: this.delegation, content });
  }

  /** Waits for the transcript to stop growing, then hands the user's words to the agent. */
  private settle(since: number): void {
    clearTimeout(this.settleTimer);
    const quietFor = this.now() - this.lastHeardAt;
    const waited = this.now() - since;
    const settle = /[.?!]["')\]]?\s*$/.test(this.heard) ? DELEGATION_SETTLE_SENTENCE_MS : DELEGATION_SETTLE_MS;
    if (quietFor < settle && waited < DELEGATION_WAIT_MAX_MS) {
      this.settleTimer = setTimeout(() => this.settle(since), settle - quietFor);
      return;
    }
    const text = this.heard.trim();
    this.heard = "";
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
}
