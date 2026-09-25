// A remote desktop session: its own RTCPeerConnection to the daemon, signaled
// over the device connection's control channel (desktop.start, then trickled
// candidates both ways) instead of the hub. It carries one video track plus
// two data channels.

import type { DesktopSource, IceCandidate } from "@everywhere/protocol";
import { describeUserAgent } from "../user-agent";
import { type DevicePeer, forceRelay, iceServers } from "../peer";
import { CHANNEL_CONTROL, CHANNEL_INPUT, type DesktopMode } from "./protocol";

export interface DesktopConnection {
  pc: RTCPeerConnection;
  stream: MediaStream;
  /** Pointer motion: unordered, never retransmitted (a stale position is useless). */
  input: RTCDataChannel;
  /** Keys, buttons, scroll, pings and everything from the host: reliable and ordered. */
  control: RTCDataChannel;
  close(): void;
}

/** desktop.start waits for a capture to start. */
const START_TIMEOUT_MS = 30_000;

export interface ConnectOptions {
  mode: DesktopMode;
  /** What to capture; the focused monitor if absent. */
  source?: DesktopSource;
  /** The desktop tab showing the session, so closing the tab ends it. */
  tabId?: string;
  onState?: (state: RTCPeerConnectionState) => void;
}

export async function connectDesktop(
  peer: DevicePeer,
  { mode, source, tabId, onState }: ConnectOptions,
): Promise<DesktopConnection> {
  const ice = await iceServers();
  const pc = new RTCPeerConnection({
    iceServers: ice.servers,
    iceTransportPolicy: forceRelay() ? "relay" : "all",
    bundlePolicy: "max-bundle",
  });
  const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
  preferCodecs(transceiver);
  pc.onconnectionstatechange = () => onState?.(pc.connectionState);
  const input = pc.createDataChannel(CHANNEL_INPUT, { ordered: false, maxRetransmits: 0 });
  const control = pc.createDataChannel(CHANNEL_CONTROL);
  input.binaryType = control.binaryType = "arraybuffer";

  const stream = new MediaStream();
  pc.ontrack = (ev) => {
    stream.addTrack(ev.track);
    minimizeReceiveDelay(ev.receiver);
  };

  // Trickle ICE. The daemon's candidates can arrive before desktop.start
  // answers (and name a session we don't know yet), so hold them until then;
  // ours wait for the session id.
  let id: string | null = null;
  let answered = false;
  const theirs: { id: string; candidate: RTCIceCandidateInit }[] = [];
  const ours: IceCandidate[] = [];
  const sendOurs = (candidate: IceCandidate) => {
    if (id) void peer.call("desktop.candidate", { id, candidate }).catch(() => {});
    else ours.push(candidate);
  };
  pc.onicecandidate = (ev) => {
    const c = ev.candidate?.toJSON();
    if (c?.candidate) sendOurs({ ...c, candidate: c.candidate });
  };
  const unsubscribe = peer.onEvent((e) => {
    if (e.event !== "desktop.candidate" || (id && e.id !== id)) return;
    if (answered) void pc.addIceCandidate(e.candidate).catch(() => {});
    else theirs.push({ id: e.id, candidate: e.candidate });
  });

  try {
    await pc.setLocalDescription(await pc.createOffer());
    const started = await peer.call(
      "desktop.start",
      { sdp: pc.localDescription?.sdp ?? "", mode, viewer: describeUserAgent(navigator.userAgent), source, tabId },
      START_TIMEOUT_MS,
    );
    id = started.id;
    await pc.setRemoteDescription({ type: "answer", sdp: started.sdp });
    answered = true;
    for (const c of theirs) if (c.id === id) await pc.addIceCandidate(c.candidate).catch(() => {});
    for (const c of ours.splice(0)) sendOurs(c);
  } catch (e) {
    unsubscribe();
    pc.close();
    if (id) void peer.call("desktop.stop", { id }).catch(() => {});
    throw e;
  }

  const sessionId = id;
  return {
    pc,
    stream,
    input,
    control,
    close() {
      unsubscribe();
      pc.onconnectionstatechange = null;
      pc.close();
      void peer.call("desktop.stop", { id: sessionId }).catch(() => {});
    },
  };
}

/** Offers only H.264, the one codec the host sends: High profile first. */
function preferCodecs(t: RTCRtpTransceiver) {
  const caps = RTCRtpReceiver.getCapabilities?.("video");
  if (!caps || !t.setCodecPreferences) return;
  const rank = (c: RTCRtpCodec): number => {
    const mime = c.mimeType.toLowerCase();
    const fmtp = c.sdpFmtpLine ?? "";
    if (mime === "video/h264" && fmtp.includes("packetization-mode=1")) return fmtp.includes("profile-level-id=64") ? 0 : 1;
    return -1;
  };
  const wanted = caps.codecs.filter((c) => rank(c) >= 0).sort((a, b) => rank(a) - rank(b));
  const rtx = caps.codecs.filter((c) => c.mimeType.toLowerCase() === "video/rtx");
  if (wanted.length) t.setCodecPreferences([...wanted, ...rtx]);
}

/** Render frames as soon as they decode; the host also sends playout-delay 0. */
function minimizeReceiveDelay(receiver: RTCRtpReceiver) {
  const r = receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number };
  try {
    r.jitterBufferTarget = 0;
  } catch {}
  try {
    r.playoutDelayHint = 0;
  } catch {}
}
