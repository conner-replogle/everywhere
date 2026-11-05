// The one Web Audio context a voice uses for everything: the mic's capture,
// the spoken replies and the visualizer. One, made after the mic is open:
// opening the mic switches iOS into call audio at another sample rate, and a
// context made before that (or several at once) is resampled and crackles.

import { log } from "./log";

let ctx: AudioContext | null = null;

/** iPhone and iPad (iPadOS says it's a Mac), and Android. */
export function isMobile(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod|Android/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/**
 * The context, made if there isn't one. fresh: a new one even if there is,
 * for a voice starting after its mic opened. On phones it asks for
 * "balanced" latency: a little more buffer than "interactive", against
 * dropouts, without a delay you'd notice in conversation.
 */
export function audioContext(fresh = false): AudioContext {
  if (fresh || ctx?.state === "closed") closeAudio();
  if (!ctx) {
    const latencyHint = isMobile() ? "balanced" : "interactive";
    const c = new AudioContext({ latencyHint });
    log("audio", "audio context made", { sampleRate: c.sampleRate, baseLatency: c.baseLatency, latencyHint, state: c.state });
    c.onstatechange = () => log("audio", `audio context ${c.state}`);
    ctx = c;
  }
  void ctx.resume();
  return ctx;
}

/** Closes it once the voice is off, so the next voice starts at the rate its mic has. */
export function closeAudio(): void {
  const c = ctx;
  ctx = null;
  if (c && c.state !== "closed") {
    log("audio", "audio context closed");
    void c.close();
  }
}

/** For bug reports. */
export function audioInfo(): { sampleRate: number; baseLatency: number; outputLatency: number; state: AudioContextState } | null {
  if (!ctx) return null;
  return { sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency ?? 0, state: ctx.state };
}
