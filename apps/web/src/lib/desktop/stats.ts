// Samples a desktop session's receive stats once a second for the stats overlay.

import { type CandidateStat, classifyPath, PATH_LABELS } from "../webrtc-stats";

export interface DesktopStats {
  codec: string;
  width: number;
  height: number;
  fps: number;
  bitrateMbps: number;
  rttMs: number | null;
  jitterBufferMs: number | null;
  decodeMs: number | null;
  /** Receive to display, per frame. */
  processingMs: number | null;
  framesDropped: number;
  packetsLost: number;
  path: string;
}

// The DOM typings don't cover every field browsers report, so read loosely.
type Report = Record<string, unknown> & { id: string; type: string };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

interface Prev {
  t: number;
  bytes: number;
  jbDelay: number;
  jbCount: number;
  decode: number;
  decoded: number;
  processing: number;
}

function candidate(r: Report | undefined): CandidateStat | null {
  if (!r) return null;
  return {
    id: r.id,
    type: str(r.candidateType),
    protocol: str(r.protocol),
    address: str(r.address) || str(r.ip),
    port: num(r.port),
    priority: null,
  };
}

export class DesktopStatsSampler {
  private prev: Prev | null = null;
  constructor(private pc: RTCPeerConnection) {}

  async sample(): Promise<DesktopStats | null> {
    const report = await this.pc.getStats();
    let inbound: Report | undefined;
    let pairId = "";
    const byId = new Map<string, Report>();
    report.forEach((s: Report) => {
      byId.set(s.id, s);
      if (s.type === "inbound-rtp" && s.kind === "video") inbound = s;
      if (s.type === "transport") pairId = str(s.selectedCandidatePairId);
    });
    if (!inbound) return null;
    let pair = byId.get(pairId);
    if (!pair) {
      // Firefox has no transport report.
      for (const r of byId.values()) if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r;
    }

    const now = num(inbound.timestamp);
    const cur: Prev = {
      t: now,
      bytes: num(inbound.bytesReceived),
      jbDelay: num(inbound.jitterBufferDelay),
      jbCount: num(inbound.jitterBufferEmittedCount),
      decode: num(inbound.totalDecodeTime),
      decoded: num(inbound.framesDecoded),
      processing: num(inbound.totalProcessingDelay),
    };
    const p = this.prev;
    this.prev = cur;

    const perFrame = (dNum: number, dDen: number) => (dDen > 0 ? (dNum / dDen) * 1000 : null);
    const codec = byId.get(str(inbound.codecId));
    const local = candidate(pair && byId.get(str(pair.localCandidateId)));
    const remote = candidate(pair && byId.get(str(pair.remoteCandidateId)));
    const kind = classifyPath(local, remote);
    const rtt = pair?.currentRoundTripTime;

    return {
      codec: codec
        ? `${str(codec.mimeType).replace("video/", "")} ${/profile-level-id=(\w+)/.exec(str(codec.sdpFmtpLine))?.[1] ?? ""}`
        : "?",
      width: num(inbound.frameWidth),
      height: num(inbound.frameHeight),
      fps: num(inbound.framesPerSecond),
      bitrateMbps: p && now > p.t ? ((cur.bytes - p.bytes) * 8) / ((now - p.t) / 1000) / 1e6 : 0,
      rttMs: typeof rtt === "number" ? rtt * 1000 : null,
      jitterBufferMs: p ? perFrame(cur.jbDelay - p.jbDelay, cur.jbCount - p.jbCount) : null,
      decodeMs: p ? perFrame(cur.decode - p.decode, cur.decoded - p.decoded) : null,
      processingMs: p ? perFrame(cur.processing - p.processing, cur.decoded - p.decoded) : null,
      framesDropped: num(inbound.framesDropped),
      packetsLost: num(inbound.packetsLost),
      path: kind ? `${PATH_LABELS[kind]} · ${remote?.address}` : "?",
    };
  }
}
