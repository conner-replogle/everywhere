import { Hono } from "hono";
import { rateLimited, tooMany } from "../security";
import type { App } from "../types";
import { requireUser } from "./auth";

// Speech to text for the composer, on Workers AI. Audio arrives base64 in a
// JSON body (the API only takes JSON; see apiGuard), as whatever the browser's
// MediaRecorder made: webm/opus in most, mp4/aac in Safari.

const MODEL = "@cf/openai/whisper-large-v3-turbo";
/** About 7.5 MB of audio: minutes of opus, more than one dictation needs. */
const MAX_AUDIO_BASE64 = 10 << 20;

export const speech = new Hono<App>();

speech.use("*", requireUser);

speech.post("/transcribe", async (c) => {
  if (await rateLimited(c, `speech:${c.var.user.id}`)) return tooMany(c);
  const body = await c.req.json<{ audio?: unknown; language?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const { audio, language } = body as { audio?: unknown; language?: unknown };
  if (typeof audio !== "string" || !audio) return c.json({ error: "audio is required" }, 400);
  if (audio.length > MAX_AUDIO_BASE64) return c.json({ error: "recording is too long" }, 413);
  try {
    const out = await c.env.AI.run(MODEL, {
      audio,
      task: "transcribe",
      // Two-letter codes only; otherwise Whisper detects the language itself.
      ...(typeof language === "string" && /^[a-z]{2}$/.test(language) ? { language } : {}),
      vad_filter: true,
      // Silence makes Whisper invent text; skip it rather than transcribe it.
      condition_on_previous_text: false,
    });
    return c.json({ text: (out.text ?? "").trim() });
  } catch (e) {
    console.error("transcribe failed", e);
    return c.json({ error: "couldn't transcribe that recording" }, 502);
  }
});
