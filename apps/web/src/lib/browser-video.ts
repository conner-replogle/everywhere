// A browser tab's video: its own RTCPeerConnection to the device's Chromium,
// which captures the tab and sends it as WebRTC video. Signaling rides the
// tab's browser channel (offer → answer, candidates trickled both ways).

import type { BrowserClientMsg, IceCandidate } from "@everywhere/protocol";
import { forceRelay, iceServers } from "./peer";

export interface VideoStats {
  fps: number;
  bitsPerSec: number;
  width: number;
  height: number;
  codec: string;
}

export class BrowserVideo {
  readonly stream = new MediaStream();
  private pc: RTCPeerConnection | null = null;
  private answered = false;
  private early: IceCandidate[] = [];
  private closed = false;
  private last = { at: 0, bytes: 0 };

  constructor(
    private send: (msg: BrowserClientMsg) => void,
    /** The connection failed for good; the caller may offer again. */
    private onFailed: () => void,
  ) {}

  /** Starts (or restarts) the connection with a fresh offer. */
  async offer(): Promise<void> {
    this.pc?.close();
    this.answered = false;
    this.early = [];
    const ice = await iceServers();
    if (this.closed) return;
    const pc = new RTCPeerConnection({
      iceServers: ice.servers,
      iceTransportPolicy: forceRelay() ? "relay" : "all",
      bundlePolicy: "max-bundle",
    });
    this.pc = pc;
    preferH264(pc.addTransceiver("video", { direction: "recvonly" }));
    pc.ontrack = (ev) => {
      for (const t of this.stream.getVideoTracks()) this.stream.removeTrack(t);
      this.stream.addTrack(ev.track);
      minimizeReceiveDelay(ev.receiver);
    };
    pc.onicecandidate = (ev) => {
      const c = ev.candidate?.toJSON();
      if (c?.candidate && this.pc === pc) this.send({ t: "ice", candidate: { ...c, candidate: c.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" && this.pc === pc && !this.closed) this.onFailed();
    };
    await pc.setLocalDescription(await pc.createOffer());
    if (this.pc === pc) this.send({ t: "offer", sdp: pc.localDescription?.sdp ?? "" });
  }

  async onAnswer(sdp: string): Promise<void> {
    const pc = this.pc;
    if (!pc || this.answered) return;
    await pc.setRemoteDescription({ type: "answer", sdp });
    this.answered = true;
    for (const c of this.early.splice(0)) await pc.addIceCandidate(c).catch(() => {});
  }

  onCandidate(c: IceCandidate): void {
    if (this.answered) void this.pc?.addIceCandidate(c).catch(() => {});
    else this.early.push(c);
  }

  async stats(): Promise<VideoStats | null> {
    const pc = this.pc;
    if (!pc) return null;
    const report = await pc.getStats();
    let out: VideoStats | null = null;
    report.forEach((s) => {
      if (s.type !== "inbound-rtp" || s.kind !== "video") return;
      const now = s.timestamp as number;
      const bytes = s.bytesReceived as number;
      const dt = (now - this.last.at) / 1000;
      const bitsPerSec = this.last.at && dt > 0 ? ((bytes - this.last.bytes) * 8) / dt : 0;
      this.last = { at: now, bytes };
      const codec = s.codecId ? (report.get(s.codecId)?.mimeType as string | undefined) : undefined;
      out = {
        fps: Math.round((s.framesPerSecond as number | undefined) ?? 0),
        bitsPerSec,
        width: (s.frameWidth as number | undefined) ?? 0,
        height: (s.frameHeight as number | undefined) ?? 0,
        codec: codec?.replace(/^video\//, "") ?? "",
      };
    });
    return out;
  }

  close(): void {
    this.closed = true;
    this.pc?.close();
    this.pc = null;
  }
}

/** H.264 first, since phones and laptops decode it in hardware; the rest as fallbacks. */
function preferH264(t: RTCRtpTransceiver) {
  const caps = RTCRtpReceiver.getCapabilities?.("video");
  if (!caps || !t.setCodecPreferences) return;
  const rank = (c: RTCRtpCodec): number => {
    const mime = c.mimeType.toLowerCase();
    const fmtp = c.sdpFmtpLine ?? "";
    if (mime === "video/h264") return fmtp.includes("packetization-mode=1") ? 0 : 1;
    if (mime === "video/vp8") return 2;
    if (mime === "video/vp9") return 3;
    return 4;
  };
  t.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
}

/** Render frames as soon as they decode. */
function minimizeReceiveDelay(receiver: RTCRtpReceiver) {
  const r = receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null; playoutDelayHint?: number };
  try {
    r.jitterBufferTarget = 0;
  } catch {}
  try {
    r.playoutDelayHint = 0;
  } catch {}
}
