// The assistant: one conversation per account that isn't on any device. Its
// agent runs in a browser tab (apps/web/src/lib/assistant); the Worker's
// Assistant DO keeps the conversation and relays live state between the
// account's tabs over GET /api/assistant/ws. JSON text frames both ways.

/**
 * One entry in the conversation log. `message` is a pi-ai message (user,
 * assistant or toolResult), kept as the agent produced it. A compaction
 * stands in for every message up to `throughSeq` when building the model's
 * context; the messages stay in the log.
 */
export type AssistantEntryData =
  | { kind: "message"; message: unknown }
  | { kind: "compaction"; summary: string; throughSeq: number };

export type AssistantEntry = AssistantEntryData & { seq: number; at: number };

/** What the running turn is doing, for tabs other than the one running it. */
export interface AssistantLive {
  /** The reply streamed so far, not yet logged. */
  text: string;
  /** What it's doing, e.g. "Reading fix flaky test". */
  activity?: string;
  /** Actions waiting for the user's yes. */
  approvals: AssistantApproval[];
  /** Cards the reply is writing (show_on_screen calls still streaming), so they fill in as it types. */
  cards?: { id: string; markdown: string }[];
  /** The tab whose message this turn answers (its tab id): only that tab's voice speaks it. */
  for?: string;
}

/** An action the assistant wants to take, shown to the user to allow or deny. */
export interface AssistantApproval {
  id: string;
  /** e.g. "Send to fix flaky test on hetzner-1". */
  title: string;
  /** The exact text that will be sent, if any. */
  detail?: string;
}

export type AssistantClientMsg =
  /** Replays the log after afterSeq; without it, from the latest compaction on. */
  | { t: "attach"; afterSeq?: number }
  /** The page of entries before beforeSeq, newest last. */
  | { t: "history"; beforeSeq: number; limit?: number }
  /** Adds entries to the log; answered with appended (and entries to every tab). */
  | { t: "append"; ref: string; entries: AssistantEntryData[] }
  /** Asks to run turns. Granted when no other connected tab is running one. */
  | { t: "claim" }
  | { t: "release" }
  /** From the tab running the turn; null when it's over. */
  | { t: "live"; live: AssistantLive | null }
  /** A prompt for the tab running the turn (sent when another tab holds it); from: the sending tab's id. */
  | { t: "steer"; text: string; from?: string }
  /** An answer to an approval, for the tab running the turn. */
  | { t: "approve"; id: string; allow: boolean }
  /** Deletes the whole conversation; answered with cleared (to every tab), or an error while a turn runs. */
  | { t: "clear" }
  /** This tab's mic is on: the others turn theirs off (one voice at a time). */
  | { t: "voice"; tab: string };

export type AssistantServerMsg =
  /**
   * runner: the connection running a turn, if any. clearedThrough: the last
   * seq the latest clear deleted; entries at or before it are gone (seqs
   * aren't reused, so a tab that missed the clear drops what it still has).
   */
  | { t: "hello"; you: string; runner: string | null; live: AssistantLive | null; clearedThrough: number }
  /** initial: the attach replay; more frames may follow until synced. */
  | { t: "entries"; entries: AssistantEntry[]; initial?: boolean }
  | { t: "synced" }
  | { t: "history"; entries: AssistantEntry[]; more: boolean }
  | { t: "appended"; ref: string; seqs: number[] }
  | { t: "runner"; runner: string | null }
  | { t: "live"; live: AssistantLive | null }
  | { t: "steer"; text: string; from?: string }
  | { t: "approve"; id: string; allow: boolean }
  /** Another tab turned its mic on. */
  | { t: "voice"; tab: string }
  /** The conversation was cleared, through seq. */
  | { t: "cleared"; throughSeq: number }
  /** steer or approve with no tab running a turn. */
  | { t: "noRunner"; text?: string }
  /** re: the request it answers, when it answers one (clear). */
  | { t: "error"; message: string; re?: AssistantClientMsg["t"] };

/** Speech to text on GET /api/assistant/listen: sent to the browser as JSON. */
export type AssistantListenMsg =
  /** event: Flux's; transcript is the turn's text so far. */
  | { t: "turn"; event: "Update" | "StartOfTurn" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn"; transcript: string }
  | { t: "error"; message: string };
