// Dictation: stream the microphone to the Worker (Workers AI, Deepgram Nova-3)
// and show the transcript as it comes. Text joins the draft only on Stop, so
// Discard leaves the draft as it was.

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/utils";

/** Long enough for any prompt; the Worker cuts sessions off a little later. */
const MAX_RECORDING_MS = 5 * 60 * 1000;
/** How often MediaRecorder hands over audio; smaller is snappier, chattier. */
const CHUNK_MS = 250;
/** After Stop, how long to wait for the last words before giving up. */
const FINISH_TIMEOUT_MS = 8000;
/** Opus in a container Nova reads while it's still being written. */
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

export type DictationState = "idle" | "recording" | "finishing";

function mimeType(): string | undefined {
  return typeof MediaRecorder === "undefined" ? undefined : MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
}

export function dictationSupported(): boolean {
  return !!mimeType() && !!navigator.mediaDevices?.getUserMedia;
}

/** Two-letter language from the browser; the Worker falls back to multilingual. */
function language(): string {
  return /^[a-z]{2}/.exec(navigator.language?.toLowerCase() ?? "")?.[0] ?? "";
}

function join(parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

type Session = { rec: MediaRecorder; discard: boolean; end: () => void };

/** Calls onText with the whole transcription when a dictation is stopped. */
export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string>();
  const [startedAt, setStartedAt] = useState(0);
  /** What's been said so far: finished phrases, then the one in progress. */
  const [live, setLive] = useState("");
  const session = useRef<Session | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const start = useCallback(async () => {
    if (session.current) return;
    setError(undefined);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setError(e instanceof DOMException && e.name === "NotAllowedError" ? "Microphone access was denied" : errorMessage(e));
      return;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/speech/stream?language=${language()}`);
    const rec = new MediaRecorder(stream, { mimeType: mimeType() });
    const timers: number[] = [];
    const finals: string[] = [];
    let interim = "";
    let failed = false;
    let done = false;

    const end = () => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      for (const t of stream.getTracks()) t.stop();
      if (rec.state !== "inactive") rec.stop();
      if (ws.readyState <= WebSocket.OPEN) ws.close();
      session.current = null;
      // A connection lost midway keeps what was heard; the rest is the error.
      const text = join([...finals, interim]);
      if (!s.discard && text) onTextRef.current(text);
      else if (!s.discard && !failed) setError("Didn't catch anything");
      setLive("");
      setState("idle");
    };
    const s: Session = { rec, discard: false, end };
    session.current = s;

    // Audio recorded before the socket opens waits; the first chunk holds the
    // container header, so none can be dropped.
    const pending: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (!e.data.size || s.discard) return;
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
      else pending.push(e.data);
    };
    rec.onstop = () => {
      if (s.discard || done) return;
      // The last chunk has been sent; Nova finishes up and closes the socket.
      setState("finishing");
      if (ws.readyState === WebSocket.OPEN) ws.send("stop");
      timers.push(window.setTimeout(end, FINISH_TIMEOUT_MS));
    };
    let opened = false;
    ws.onopen = () => {
      opened = true;
      for (const b of pending.splice(0)) ws.send(b);
      if (rec.state === "inactive") ws.send("stop");
    };
    ws.onmessage = (e) => {
      let msg: { text?: string; final?: boolean };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const text = msg.text ?? "";
      if (msg.final) {
        if (text) finals.push(text);
        interim = "";
      } else {
        interim = text;
      }
      setLive(join([...finals, interim]));
    };
    ws.onclose = (e) => {
      if (done) return;
      if (e.code !== 1000 && !s.discard) {
        failed = true;
        setError(opened ? "Dictation was cut off" : "Couldn't start dictation");
      }
      end();
    };

    rec.start(CHUNK_MS);
    timers.push(window.setTimeout(() => rec.state !== "inactive" && rec.stop(), MAX_RECORDING_MS));
    setLive("");
    setStartedAt(Date.now());
    setState("recording");
  }, []);

  const stop = useCallback(() => {
    if (session.current?.rec.state === "recording") session.current.rec.stop();
  }, []);

  const cancel = useCallback(() => {
    const s = session.current;
    if (!s) return;
    s.discard = true;
    s.end();
  }, []);

  // Leaving the thread mid-dictation releases the microphone.
  useEffect(() => cancel, [cancel]);

  return { state, error, startedAt, live, start, stop, cancel, clearError: () => setError(undefined) };
}

export type Dictation = ReturnType<typeof useDictation>;
