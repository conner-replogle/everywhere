// The assistant's messages as data: the model's context built from the
// conversation log, and the text of messages as shown and as spoken. No
// browser state, so it's tested on its own.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import type { AssistantEntry } from "@everywhere/protocol";

export const CONTEXT_OPEN = "<context>";
export const CONTEXT_CLOSE = "</context>";

/** A user message's text without its context note: what the user said. */
export function spokenPart(text: string): string {
  const i = text.lastIndexOf(CONTEXT_OPEN);
  return (i >= 0 ? text.slice(0, i) : text).trim();
}

export function messageText(m: AgentMessage): string {
  const c = (m as Message).content;
  if (typeof c === "string") return c;
  return c
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export function userMessage(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

/** The model's context from the log: the latest summary, then what it doesn't cover. */
export function contextFrom(entries: AssistantEntry[]): AgentMessage[] {
  let compaction: (AssistantEntry & { kind: "compaction" }) | undefined;
  for (const e of entries) if (e.kind === "compaction" && (!compaction || e.seq > compaction.seq)) compaction = e;
  const through = compaction?.throughSeq ?? 0;
  const messages: AgentMessage[] = [];
  if (compaction) {
    messages.push(userMessage(`[Summary of the conversation before this point]\n${compaction.summary}`));
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: "Understood, I have the summary." }],
      api: "openai-completions",
      provider: "workers-ai",
      model: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: compaction.at,
    } satisfies AssistantMessage);
  }
  for (const e of entries) if (e.kind === "message" && e.seq > through) messages.push(e.message as AgentMessage);
  return repair(messages);
}

/**
 * Makes a log the model will take: drops failed replies, and answers tool
 * calls whose results never came (a tab closed mid-turn).
 */
function repair(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Message;
    if (m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted") && !m.content.length) continue;
    out.push(m);
    if (m.role !== "assistant") continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < messages.length && (messages[j] as Message).role === "toolResult"; j++) {
      answered.add((messages[j] as ToolResultMessage).toolCallId);
    }
    for (const b of m.content) {
      if (b.type !== "toolCall" || answered.has(b.id)) continue;
      out.push({
        role: "toolResult",
        toolCallId: b.id,
        toolName: b.name,
        content: [{ type: "text", text: "Not run: the conversation was interrupted." }],
        isError: true,
        timestamp: m.timestamp,
      } satisfies ToolResultMessage);
    }
  }
  return out;
}

export function convertToLlm(messages: AgentMessage[]): Message[] {
  return (messages as Message[]).filter(
    (m) => !(m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted") && !m.content.length),
  );
}

/** Text as it should be read out: no markdown, code or links. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A spoken answer to a waiting approval (after any filler, see approvalAnswer). */
export const YES =
  /^(yes|yeah|yea|yep|yup|ya|sure|ok|okay|alright|all right|go ahead|go for it|do it|send it|send|start it|start|approve|approved|allow|allowed|confirm|confirmed|please do|yes please|absolutely|definitely|of course|sounds good|that's fine)\b/i;
export const NO = /^(no|nope|nah|don'?t|do not|cancel|deny|denied|stop|wait|hold on|never ?mind)\b/i;
const FILLER = /^((uh|um|uhm|er|oh|well|hmm|mm|so|and|hey|yes or no)[,.!]?\s+)+/i;

/** Whether what was said answers a waiting approval: true for yes, false for no, null for neither. */
export function approvalAnswer(text: string): boolean | null {
  const t = text.trim().replace(/^["'“]/, "").replace(FILLER, "");
  if (NO.test(t)) return false;
  if (YES.test(t)) return true;
  return null;
}
