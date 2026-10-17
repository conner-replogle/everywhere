import { Hono } from "hono";
import { rateLimited, tooMany } from "../security";
import type { App } from "../types";
import { requireUser } from "./auth";

// Rewrites a composer draft into a clearer prompt, on a small Workers AI
// model. The client sends the thread's recent messages (text only, no tool
// calls) so "that" and "it" resolve to what was being talked about.

/** Mixture of experts with ~4B active: quick, and it kept to the user's intent where 8B models invented fixes. */
const MODEL = "@cf/google/gemma-4-26b-a4b-it";
/** Roughly the last few thousand tokens of conversation. */
const MAX_CONTEXT_CHARS = 16_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_DRAFT_CHARS = 20_000;

const SYSTEM = `You rewrite a draft prompt that a user is about to send to Claude, an AI coding agent working in their project.
Make the draft clear, specific and well organized so Claude can act on it:
- Keep the user's intent, scope and first-person voice. Don't add requirements, guesses or steps they didn't ask for.
- Use the recent conversation only to resolve references ("that", "it", "the bug") into the concrete things they mean.
- Fix typos, grammar and speech-to-text mistakes. Drop filler and repetition.
- Keep code, paths, names and commands exactly as written.
- Keep it about as short as the request needs; a one-line ask stays one or two sentences.
Reply with only the rewritten prompt: no preamble, quotes, explanation, or answer to the prompt itself.`;

interface ContextMessage {
  role: "user" | "claude";
  text: string;
}

function clip(s: string, max: number): string {
  s = s.trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The newest messages that fit, oldest first. */
function conversation(messages: ContextMessage[]): string {
  const out: string[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const block = `${m.role === "user" ? "USER" : "CLAUDE"}:\n${clip(m.text, MAX_MESSAGE_CHARS)}`;
    if (total + block.length > MAX_CONTEXT_CHARS) break;
    out.unshift(block);
    total += block.length + 2;
  }
  return out.join("\n\n");
}

export const prompt = new Hono<App>();

prompt.use("*", requireUser);

prompt.post("/rewrite", async (c) => {
  if (await rateLimited(c, `rewrite:${c.var.user.id}`)) return tooMany(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const draft = typeof body.draft === "string" ? body.draft.trim() : "";
  if (!draft) return c.json({ error: "draft is required" }, 400);
  if (draft.length > MAX_DRAFT_CHARS) return c.json({ error: "draft is too long to rewrite" }, 413);
  const messages = (Array.isArray(body.context) ? body.context : []).filter(
    (m): m is ContextMessage =>
      !!m && typeof m === "object" && (m.role === "user" || m.role === "claude") && typeof m.text === "string",
  );
  const context = conversation(messages);
  try {
    const out = await c.env.AI.run(MODEL, {
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `${context ? `<conversation>\n${context}\n</conversation>\n\n` : ""}<draft>\n${draft}\n</draft>`,
        },
      ],
      max_tokens: 2048,
      temperature: 0.2,
    });
    const content = out.choices[0]?.message?.content;
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) return c.json({ error: "the rewrite came back empty" }, 502);
    return c.json({ text });
  } catch (e) {
    console.error("rewrite failed", e);
    return c.json({ error: "couldn't rewrite that prompt" }, 502);
  }
});
