// Dictation: record from the microphone, then have the Worker transcribe it
// (Workers AI Whisper). Recording happens here; nothing streams while talking.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

/** Long enough for any prompt, short enough to stay under the Worker's limit. */
const MAX_RECORDING_MS = 5 * 60 * 1000;
/** Containers Whisper decodes, best first; Safari only records mp4. */
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export type DictationState = "idle" | "recording" | "transcribing";

export function dictationSupported(): boolean {
  return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("couldn't read the recording"));
    reader.readAsDataURL(blob);
  });
}

/** Two-letter language for Whisper, from the browser; undefined lets it detect. */
function language(): string | undefined {
  return /^[a-z]{2}/.exec(navigator.language?.toLowerCase() ?? "")?.[0];
}

/** Calls onText with each finished transcription. */
export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string>();
  const [startedAt, setStartedAt] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const discard = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const start = useCallback(async () => {
    if (recorder.current) return;
    setError(undefined);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setError(e instanceof DOMException && e.name === "NotAllowedError" ? "Microphone access was denied" : errorMessage(e));
      return;
    }
    const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    const timer = setTimeout(() => rec.state !== "inactive" && rec.stop(), MAX_RECORDING_MS);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      clearTimeout(timer);
      for (const t of stream.getTracks()) t.stop();
      recorder.current = null;
      if (discard.current || chunks.length === 0) {
        discard.current = false;
        setState("idle");
        return;
      }
      setState("transcribing");
      try {
        const audio = await blobToBase64(new Blob(chunks, { type: rec.mimeType }));
        const { text } = await api.transcribe(audio, language());
        if (text) onTextRef.current(text);
        else setError("Didn't catch anything");
      } catch (e) {
        setError(errorMessage(e));
      }
      setState("idle");
    };
    recorder.current = rec;
    discard.current = false;
    rec.start();
    setStartedAt(Date.now());
    setState("recording");
  }, []);

  const stop = useCallback(() => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  const cancel = useCallback(() => {
    discard.current = true;
    stop();
  }, [stop]);

  // Leaving the thread mid-recording releases the microphone.
  useEffect(() => cancel, [cancel]);

  return { state, error, startedAt, start, stop, cancel, clearError: () => setError(undefined) };
}
