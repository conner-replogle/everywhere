import { Hono } from "hono";
import { ASSISTANT_SESSION_HEADER } from "../assistant";
import { originAllowed } from "../security";
import type { App } from "../types";
import { workersAiMessage } from "../workers-ai";
import { requireUser } from "./auth";

// The assistant's Worker side. Its agent runs in the browser; the Worker
// keeps the conversation (the Assistant DO), runs the model on Workers AI,
// and does speech both ways. None of it can reach a device.

/** Models the browser may ask for: Workers AI ones that call tools well. */
export const ASSISTANT_MODELS = new Set([
  "@cf/openai/gpt-oss-120b",
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/zai-org/glm-5.3",
  "@cf/zai-org/glm-5.3-flash",
  "@cf/qwen/qwen3.8-27b",
]);
/** Fields of an OpenAI chat completion request that Workers AI takes. */
const PASSED = ["messages", "tools", "tool_choice", "stream", "max_tokens", "temperature", "top_p", "reasoning_effort"];
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 16_000;

const LISTEN_MODEL = "@cf/deepgram/flux";
const SPEAK_MODEL = "@cf/deepgram/aura-2-en";
const VOICES = new Set(["luna", "thalia", "andromeda", "helena", "apollo", "arcas", "orion", "zeus", "athena", "aurora"]);
const MAX_SPEAK_CHARS = 2000;
/** A conversation can go on; don't hold an upstream socket forever. */
const MAX_LISTEN_MS = 30 * 60 * 1000;
const FAILED = 4000;

export const assistant = new Hono<App>();

assistant.use("*", requireUser);

async function limited(c: Parameters<typeof requireUser>[0], what: string): Promise<boolean> {
  const { success } = await c.env.ASSISTANT_LIMITER.limit({ key: `${what}:${c.var.user.id}` });
  return !success;
}

// The conversation: a WebSocket to the account's Assistant DO.
assistant.get("/ws", async (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.text("expected websocket", 426);
  if (!originAllowed(c)) return c.json({ error: "cross-origin websocket rejected" }, 403);
  const headers = new Headers(c.req.raw.headers);
  headers.set(ASSISTANT_SESSION_HEADER, c.var.sessionId);
  const stub = c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName(c.var.user.id));
  return stub.fetch(new Request(c.req.raw, { headers }));
});

// The model, as an OpenAI-compatible chat completions endpoint so the agent
// (pi-ai's openai-completions provider) can talk to it as is. Streams SSE.
assistant.post("/v1/chat/completions", async (c) => {
  if (await limited(c, "model")) return c.json({ error: { message: "too many requests; wait a minute" } }, 429);
  if (Number(c.req.header("content-length") ?? 0) > MAX_REQUEST_BYTES) {
    return c.json({ error: { message: "conversation too large" } }, 413);
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body.model !== "string" || !ASSISTANT_MODELS.has(body.model) || !Array.isArray(body.messages)) {
    return c.json({ error: { message: "unknown model or no messages" } }, 400);
  }
  const input: Record<string, unknown> = {};
  for (const k of PASSED) if (body[k] !== undefined) input[k] = body[k];
  input.max_tokens = Math.min(Number(body.max_tokens ?? body.max_completion_tokens ?? MAX_OUTPUT_TOKENS), MAX_OUTPUT_TOKENS);
  input.messages = (body.messages as Record<string, unknown>[]).map(workersAiMessage);
  try {
    const out = await c.env.AI.run(body.model as never, input as never);
    if (out instanceof ReadableStream) {
      return new Response(out, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    }
    return c.json(out as object);
  } catch (e) {
    console.error("assistant model failed", e);
    return c.json({ error: { message: `the model failed: ${e instanceof Error ? e.message : String(e)}` } }, 502);
  }
});

// Speech to text with turn detection (Flux): the browser sends 16 kHz mono
// 16-bit PCM as binary messages and gets turn events back as you talk.
assistant.get("/listen", async (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.text("expected websocket", 426);
  if (!originAllowed(c)) return c.json({ error: "cross-origin websocket rejected" }, 403);
  if (await limited(c, "listen")) return c.json({ error: "too many requests" }, 429);

  let upstream: WebSocket;
  try {
    const params = { encoding: "linear16", sample_rate: "16000", eot_threshold: "0.7", eot_timeout_ms: "4000" };
    const res = await c.env.AI.run(LISTEN_MODEL, params as never, { websocket: true });
    if (!res.webSocket) throw new Error(`no websocket (${res.status}): ${await res.text()}`);
    upstream = res.webSocket;
  } catch (e) {
    console.error("listen failed", e);
    return c.json({ error: "speech to text is unavailable" }, 502);
  }
  upstream.accept();

  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  const close = (code = 1000, reason = "") => {
    clearTimeout(timer);
    for (const ws of [server, upstream]) {
      try {
        ws.close(code, reason);
      } catch {}
    }
  };
  const timer = setTimeout(() => close(1000, "too long"), MAX_LISTEN_MS);

  let queue = Promise.resolve();
  server.addEventListener("message", (e) => {
    if (typeof e.data === "string") return;
    queue = queue
      .then(async () => upstream.send(e.data instanceof Blob ? await e.data.arrayBuffer() : e.data))
      .catch(() => close(FAILED, "upstream send failed"));
  });
  upstream.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    let msg: { type?: string; event?: string; transcript?: string; description?: string };
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "Error" || msg.type === "FatalError") {
      console.error("listen upstream error", e.data);
      server.send(JSON.stringify({ t: "error", message: msg.description ?? "speech to text failed" }));
      return close(FAILED, "transcription failed");
    }
    // Deepgram tags these TurnInfo; the event is what matters.
    if (!msg.event) return;
    server.send(JSON.stringify({ t: "turn", event: msg.event, transcript: msg.transcript ?? "" }));
  });
  upstream.addEventListener("close", (e) => close(e.code === 1000 ? 1000 : FAILED, e.reason.slice(0, 100)));
  upstream.addEventListener("error", () => close(FAILED, "transcription failed"));
  server.addEventListener("close", () => close());

  return new Response(null, { status: 101, webSocket: client });
});

// Text to speech (Aura 2): one sentence or a few at a time, as MP3.
assistant.post("/speak", async (c) => {
  if (await limited(c, "speak")) return c.json({ error: "too many requests" }, 429);
  const body = await c.req.json<{ text?: unknown; voice?: unknown }>().catch(() => ({}) as { text?: unknown; voice?: unknown });
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_SPEAK_CHARS) : "";
  if (!text) return c.json({ error: "text is required" }, 400);
  const speaker = typeof body.voice === "string" && VOICES.has(body.voice) ? body.voice : "luna";
  try {
    const res = (await c.env.AI.run(SPEAK_MODEL, { text, speaker, encoding: "mp3" } as never, {
      returnRawResponse: true,
    })) as Response;
    if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
    return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  } catch (e) {
    console.error("speak failed", e);
    return c.json({ error: "text to speech is unavailable" }, 502);
  }
});
