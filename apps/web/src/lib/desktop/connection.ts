// A remote desktop session: its own RTCPeerConnection to the daemon, a
// "desktop" plugin session (rtc.open; desktop.start on daemons from before
// plugins). It carries one video track plus two data channels.

import type { DesktopSource } from "@everywhere/protocol";
import { describeUserAgent } from "../user-agent";
import { type DevicePeer, forceRelay, iceServers } from "../peer";
import { negotiate, rtcSignaling, type SessionSignaling } from "../rtc-session";
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
/** How long an ended session waits for the host's SessionEnded before closing. */
const ENDED_GRACE_MS = 500;

export interface ConnectOptions {
  mode: DesktopMode;
  /** What to capture; the focused monitor if absent. */
  source?: DesktopSource;
  /** The desktop tab showing the session, so closing the tab ends it. */
  tabId?: string;
  /** The device serves plugin sessions (feature "plugins"). */
  rtc?: boolean;
  onState?: (state: RTCPeerConnectionState) => void;
  /** The daemon ended the session; the connection is closed. */
  onEnded?: (reason?: string) => void;
}

/** Signaling on daemons from before plugin sessions. */
function legacySignaling(peer: DevicePeer, params: { mode: string; viewer: string; source?: DesktopSource; tabId?: string }): SessionSignaling {
  return {
    start: (sdp) => peer.call("desktop.start", { sdp, ...params }, START_TIMEOUT_MS),
    candidate: (id, candidate) => void peer.call("desktop.candidate", { id, candidate }).catch(() => {}),
    stop: (id) => void peer.call("desktop.stop", { id }).catch(() => {}),
    theirCandidate: (e) => (e.event === "desktop.candidate" ? { id: e.id, candidate: e.candidate } : null),
  };
}

export async function connectDesktop(
  peer: DevicePeer,
  { mode, source, tabId, rtc, onState, onEnded }: ConnectOptions,
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

  const params = { mode, viewer: describeUserAgent(navigator.userAgent), source, tabId };
  const sig = rtc ? rtcSignaling(peer, "desktop", params, START_TIMEOUT_MS) : legacySignaling(peer, params);
  let session;
  try {
    // A moment's grace first: the host's own SessionEnded, on the control
    // channel, says more than the signaling's reason.
    session = await negotiate(peer, pc, sig, (reason) => {
      setTimeout(() => {
        if (pc.connectionState === "closed") return;
        pc.onconnectionstatechange = null;
        pc.close();
        onEnded?.(reason);
      }, ENDED_GRACE_MS);
    });
  } catch (e) {
    pc.close();
    throw e;
  }
  return {
    pc,
    stream,
    input,
    control,
    close() {
      pc.onconnectionstatechange = null;
      pc.close();
      session.close();
    },
  };
}

/** Offers only codecs the host can send, H.264 High first. The host picks per mode. */
function preferCodecs(t: RTCRtpTransceiver) {
  const caps = RTCRtpReceiver.getCapabilities?.("video");
  if (!caps || !t.setCodecPreferences) return;
  const rank = (c: RTCRtpCodec): number => {
    const mime = c.mimeType.toLowerCase();
    const fmtp = c.sdpFmtpLine ?? "";
    if (mime === "video/h264" && fmtp.includes("packetization-mode=1")) return fmtp.includes("profile-level-id=64") ? 0 : 1;
    if (mime === "video/h265" && /profile-id=1(;|$)/.test(fmtp)) return 2;
    if (mime === "video/av1" && /profile=0/.test(fmtp)) return 3;
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
