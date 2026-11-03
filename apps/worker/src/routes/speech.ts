import { Hono } from "hono";
import { originAllowed, rateLimited, tooMany } from "../security";
import type { App } from "../types";
import { requireUser } from "./auth";

// Live speech to text for the composer, on Workers AI (Deepgram Nova-3 over a
// WebSocket). The browser sends MediaRecorder chunks (webm or ogg Opus; Nova
// reads the container) as binary messages and "stop" when it's done; it gets
// back {text, final} as you talk. Interim text is replaced by the next
// message until one is final; finals add up to the whole transcript.

const MODEL = "@cf/deepgram/nova-3";
/** Languages Nova-3 transcribes on their own; anything else goes to "multi". */
const LANGUAGES = new Set(["en", "es", "fr", "de", "hi", "ru", "pt", "ja", "it", "nl"]);
/** A dictation is minutes at most; don't hold an upstream socket forever. */
const MAX_SESSION_MS = 6 * 60 * 1000;
/** Close code for a failed transcription (1000 is a normal end). */
const FAILED = 4000;

export const speech = new Hono<App>();

speech.use("*", requireUser);

speech.get("/stream", async (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.text("expected websocket", 426);
  if (!originAllowed(c)) return c.json({ error: "cross-origin websocket rejected" }, 403);
  if (await rateLimited(c, `speech:${c.var.user.id}`)) return tooMany(c);
  const lang = c.req.query("language") ?? "";

  let upstream: WebSocket;
  try {
    // Over the socket every option is a string, and there's no audio up front.
    const params = {
      language: LANGUAGES.has(lang) ? lang : "multi",
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
    };
    const res = await c.env.AI.run(MODEL, params as never, { websocket: true });
    if (!res.webSocket) throw new Error(`no websocket (${res.status}): ${await res.text()}`);
    upstream = res.webSocket;
  } catch (e) {
    console.error("speech stream failed", e);
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
  const timer = setTimeout(() => close(1000, "too long"), MAX_SESSION_MS);

  // Audio may arrive as a Blob; reading one is async, so a queue keeps order.
  let queue = Promise.resolve();
  server.addEventListener("message", (e) => {
    queue = queue
      .then(async () => {
        if (typeof e.data === "string") {
          // Nova transcribes what's left, sends its finals, then closes.
          if (e.data === "stop") upstream.send(JSON.stringify({ type: "CloseStream" }));
          return;
        }
        upstream.send(e.data instanceof Blob ? await e.data.arrayBuffer() : e.data);
      })
      .catch(() => close(FAILED, "upstream send failed"));
  });
  upstream.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    let msg: { type?: string; is_final?: boolean; channel?: { alternatives?: { transcript?: string }[] } };
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "Error") {
      console.error("speech upstream error", e.data);
      return close(FAILED, "transcription failed");
    }
    if (msg.type !== "Results") return;
    const text = msg.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
    server.send(JSON.stringify({ text, final: !!msg.is_final }));
  });
  upstream.addEventListener("close", (e) => close(e.code === 1000 ? 1000 : FAILED, e.reason.slice(0, 100)));
  upstream.addEventListener("error", () => close(FAILED, "transcription failed"));
  server.addEventListener("close", () => close());

  return new Response(null, { status: 101, webSocket: client });
});
