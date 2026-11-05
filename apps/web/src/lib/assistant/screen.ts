// What the assistant has put on the screen: the cards from its
// show_on_screen and clear_screen calls, worked out from the conversation
// log, so every tab and device shows the same ones and a reload keeps them.
// A card lasts while it's in use: one shown or updated in a turn stays
// through the next turn, and is gone once a turn after that starts without
// the model touching it.

import type { AssistantEntry } from "@everywhere/protocol";
import type { Message, ToolResultMessage } from "@mariozechner/pi-ai";

export const SHOW_TOOL = "show_on_screen";
export const CLEAR_TOOL = "clear_screen";
/** The most markdown one card holds. */
export const MAX_CARD_MARKDOWN = 1200;
/** The most cards at once; showing another drops the oldest. */
export const MAX_CARDS = 3;

export interface ScreenCard {
  id: string;
  markdown: string;
  /** The seq of the message that last showed or updated it. */
  seq: number;
}

/** A card id as the tools take it: short, lowercase, dashes. */
export function cardId(raw: unknown): string {
  const id = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return id || "card";
}

interface Shown extends ScreenCard {
  turn: number;
}

/**
 * The cards still up after these entries, oldest first, with the turn each
 * was last shown in, and the current turn. A user message (an [Update] from
 * a watched thread too) starts a turn.
 */
function screen(entries: AssistantEntry[]): { cards: Shown[]; turn: number } {
  const cards = new Map<string, Shown>();
  const failed = new Set<string>();
  // Calls whose results said they failed show nothing.
  for (const e of entries) {
    if (e.kind !== "message") continue;
    const m = e.message as Message;
    if (m.role === "toolResult" && (m as ToolResultMessage).isError) failed.add((m as ToolResultMessage).toolCallId);
  }
  let turn = 0;
  for (const e of entries) {
    if (e.kind !== "message") continue;
    const m = e.message as Message;
    if (m.role === "user") {
      turn++;
      continue;
    }
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type !== "toolCall" || failed.has(b.id)) continue;
      const args = (b.arguments ?? {}) as Record<string, unknown>;
      if (b.name === SHOW_TOOL) {
        const markdown = typeof args.markdown === "string" ? args.markdown.trim() : "";
        if (!markdown) continue;
        const id = cardId(args.id);
        cards.delete(id);
        cards.set(id, { id, markdown: markdown.slice(0, MAX_CARD_MARKDOWN), seq: e.seq, turn });
        // The oldest go first when there are too many.
        while (cards.size > MAX_CARDS) cards.delete(cards.keys().next().value!);
      } else if (b.name === CLEAR_TOOL) {
        if (args.id === undefined || args.id === null || args.id === "") cards.clear();
        else cards.delete(cardId(args.id));
      }
    }
  }
  return { cards: [...cards.values()].filter((c) => turn - c.turn <= 1), turn };
}

/** The cards on screen after these entries, newest first. */
export function screenCards(entries: AssistantEntry[]): ScreenCard[] {
  return screen(entries)
    .cards.reverse()
    .map(({ id, markdown, seq }) => ({ id, markdown, seq }));
}

/**
 * The cards the model will still see on screen once the user's next message
 * starts a turn (those shown or updated in this one), for its context note.
 */
export function screenNote(entries: AssistantEntry[]): string {
  const { cards, turn } = screen(entries);
  const lasting = cards.filter((c) => c.turn === turn);
  if (!lasting.length) return "";
  const titles = lasting.map((c) => `[${c.id}] ${firstLine(c.markdown)}`);
  return `On screen: ${titles.join("; ")}. Update one by showing its id again, or clear it when it's done with; a card you don't touch this turn goes away.`;
}

function firstLine(markdown: string): string {
  const line = markdown.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^#+\s*/, "").replace(/[*_`]/g, "").slice(0, 60);
}
