// The assistant's microphone: which input this browser uses (the desktop
// app has no picker of its own, and the system default is often the wrong
// one), opening it, and what it was, for bug reports.

const KEY = "ew.assistant.mic";

/** The chosen input's deviceId, or "" for the system default. */
export function micDeviceId(): string {
  return localStorage.getItem(KEY) ?? "";
}

export function setMicDeviceId(id: string): void {
  if (id) localStorage.setItem(KEY, id);
  else localStorage.removeItem(KEY);
}

const VOICE: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };

/** Opens the chosen mic; the default if that one is gone (unplugged, or another browser's id). */
export async function openMic(): Promise<MediaStream> {
  const id = micDeviceId();
  if (id) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...VOICE, deviceId: { exact: id } } });
    } catch (e) {
      if (!(e instanceof DOMException && (e.name === "OverconstrainedError" || e.name === "NotFoundError"))) throw e;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: VOICE });
}

/** The inputs there are. Labels are empty until the page has had mic access once. */
export async function micInputs(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "audioinput");
}

/** What a bug report says about the mic a voice is using. */
export interface MicInfo {
  label: string;
  readyState: MediaStreamTrackState;
  muted: boolean;
  enabled: boolean;
  settings: MediaTrackSettings;
}

export function micInfo(stream: MediaStream | null): MicInfo | null {
  const t = stream?.getAudioTracks()[0];
  if (!t) return null;
  return { label: t.label, readyState: t.readyState, muted: t.muted, enabled: t.enabled, settings: t.getSettings() };
}
