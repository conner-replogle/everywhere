// GPT-Live (OpenAI's full-duplex voice model) as the assistant's voice. The
// browser's WebRTC offer goes to OpenAI from here, with the account's API key,
// and the answer goes back; audio and events then flow between the browser
// and OpenAI directly. GPT-Live hands the work to the assistant's own agent
// (client delegation), so it gets no tools of its own.

export const LIVE_URL = "https://api.openai.com/v1/live/sessions";
export const LIVE_MODEL = "gpt-live-1";
export const LIVE_VOICES = ["marin", "quartz", "ripple", "vesper", "willow", "stone", "gleam", "meridian", "beacon", "delta", "cinder"];

const MAX_SDP = 32_000;
/**
 * All the browser sends on the data channel: what the agent found, quiet
 * notes, and the close. OpenAI refuses anything else from it.
 */
export const LIVE_CLIENT_EVENTS = ["session.commentary.append", "session.thinking.append", "session.close"];
/** GPT-Live takes up to 16 384 tokens of instructions. */
const MAX_INSTRUCTIONS = 40_000;
/** And up to 128 seed messages, 8192 tokens in all. */
const MAX_INPUT_MESSAGES = 128;
const MAX_INPUT_CHARS = 28_000;

export interface LiveRequest {
  sdp: string;
  instructions: string;
  /** Earlier conversation to seed the session with, oldest first. */
  input: { role: "user" | "assistant"; text: string }[];
  voice?: string;
}

/** The body for POST /v1/live/sessions, or why the request can't make one. */
export function liveSessionBody(r: Partial<LiveRequest>): { body: unknown } | { error: string } {
  if (typeof r.sdp !== "string" || !r.sdp.startsWith("v=") || r.sdp.length > MAX_SDP) return { error: "a WebRTC offer is required" };
  const instructions = typeof r.instructions === "string" ? r.instructions.slice(0, MAX_INSTRUCTIONS) : "";
  const input: unknown[] = [];
  let chars = 0;
  // The newest messages that fit, kept in order.
  for (const m of (Array.isArray(r.input) ? r.input : []).slice(-MAX_INPUT_MESSAGES).reverse()) {
    if ((m?.role !== "user" && m?.role !== "assistant") || typeof m.text !== "string" || !m.text.trim()) continue;
    chars += m.text.length;
    if (chars > MAX_INPUT_CHARS) break;
    input.unshift({
      type: "message",
      role: m.role,
      content: [{ type: m.role === "user" ? "input_text" : "output_text", text: m.text }],
    });
  }
  const voice = r.voice && LIVE_VOICES.includes(r.voice) ? r.voice : "marin";
  return {
    body: {
      session: {
        model: LIVE_MODEL,
        instructions,
        ...(input.length ? { input } : {}),
        audio: { output: { voice } },
        delegation: { type: "client" },
        client: { data_channel: { allowed_client_events: LIVE_CLIENT_EVENTS } },
      },
      transport: { type: "webrtc", sdp: r.sdp },
    },
  };
}
