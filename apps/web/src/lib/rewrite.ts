// Prompt rewrites: a small Workers AI model tidies the composer's draft,
// using the thread's recent conversation (text only) to resolve what it
// refers to.

import type { LoggedEvent } from "./agent";

/** A bit over what the Worker keeps, so it has the newest messages to choose from. */
const MAX_CONTEXT_CHARS = 20_000;

export interface RewriteMessage {
  role: "user" | "claude";
  text: string;
}

/** The thread's latest prompts and replies, oldest first: no tool calls, thinking or subagents. */
export function rewriteContext(events: LoggedEvent[]): RewriteMessage[] {
  const out: RewriteMessage[] = [];
  let total = 0;
  for (let i = events.length - 1; i >= 0 && total < MAX_CONTEXT_CHARS; i--) {
    const ev = events[i]!.event;
    if (ev.parentId) continue;
    const text = ev.type === "user" || ev.type === "assistant" ? ev.text?.trim() : undefined;
    if (!text) continue;
    out.unshift({ role: ev.type === "user" ? "user" : "claude", text });
    total += text.length;
  }
  return out;
}
