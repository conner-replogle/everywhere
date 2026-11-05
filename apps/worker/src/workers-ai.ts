/**
 * An OpenAI chat message as Workers AI takes it: content is always a string
 * (text parts joined; no null for a reply that only calls tools), and there's
 * no developer role. Earlier replies' reasoning is dropped: models read it as
 * part of the reply and start narrating their reasoning in the answer.
 */
export function workersAiMessage(m: Record<string, unknown>): Record<string, unknown> {
  const { reasoning: _r, reasoning_content: _rc, ...out } = m;
  if (out.role === "developer") out.role = "system";
  if (Array.isArray(out.content)) {
    out.content = (out.content as { type?: string; text?: string }[])
      .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
      .join("");
  } else if (typeof out.content !== "string") {
    out.content = "";
  }
  return out;
}
