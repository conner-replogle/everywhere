// Distills RTCPeerConnection.getStats() into what the debug panel shows.

export interface CandidateStat {
  id: string;
  type: string; // host | srflx | prflx | relay
  protocol: string;
  address: string;
  port: number | null;
  priority: number | null;
  relayProtocol?: string;
  networkType?: string;
}

export interface SelectedPairStat {
  id: string;
  state: string;
  nominated: boolean;
  local: CandidateStat | null;
  remote: CandidateStat | null;
  /** ms */
  currentRoundTripTime: number | null;
  /** bits per second */
  availableOutgoingBitrate: number | null;
  bytesSent: number;
  bytesReceived: number;
  requestsSent: number;
  requestsReceived: number;
  responsesSent: number;
  responsesReceived: number;
}

export interface DataChannelStat {
  id: string;
  label: string;
  state: string;
  messagesSent: number;
  messagesReceived: number;
  bytesSent: number;
  bytesReceived: number;
}

export interface StatsSample {
  at: number;
  selectedPair: SelectedPairStat | null;
  dataChannels: DataChannelStat[];
  localCandidates: CandidateStat[];
  remoteCandidates: CandidateStat[];
}

// The DOM typings don't cover every field browsers report, so read loosely.
type Report = Record<string, unknown> & { id: string; type: string };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function candidate(r: Report): CandidateStat {
  return {
    id: r.id,
    type: str(r.candidateType),
    protocol: str(r.protocol),
    // `ip` is the pre-2021 name for `address`.
    address: str(r.address) || str(r.ip),
    port: num(r.port),
    priority: num(r.priority),
    relayProtocol: str(r.relayProtocol) || undefined,
    networkType: str(r.networkType) || undefined,
  };
}

export async function sampleStats(pc: RTCPeerConnection): Promise<StatsSample> {
  const report = await pc.getStats();
  const byId = new Map<string, Report>();
  report.forEach((r: Report) => byId.set(r.id, r));

  let pairId: string | undefined;
  for (const r of byId.values()) {
    if (r.type === "transport" && typeof r.selectedCandidatePairId === "string") pairId = r.selectedCandidatePairId;
  }
  let pair = pairId ? byId.get(pairId) : undefined;
  if (!pair) {
    // Firefox has no transport report; pick the busiest nominated, succeeded pair.
    for (const r of byId.values()) {
      if (r.type !== "candidate-pair" || !r.nominated || r.state !== "succeeded") continue;
      if (!pair || (num(r.bytesReceived) ?? 0) > (num(pair.bytesReceived) ?? 0)) pair = r;
    }
  }

  const localCandidates: CandidateStat[] = [];
  const remoteCandidates: CandidateStat[] = [];
  const dataChannels: DataChannelStat[] = [];
  for (const r of byId.values()) {
    if (r.type === "local-candidate") localCandidates.push(candidate(r));
    else if (r.type === "remote-candidate") remoteCandidates.push(candidate(r));
    else if (r.type === "data-channel") {
      dataChannels.push({
        id: r.id,
        label: str(r.label),
        state: str(r.state),
        messagesSent: num(r.messagesSent) ?? 0,
        messagesReceived: num(r.messagesReceived) ?? 0,
        bytesSent: num(r.bytesSent) ?? 0,
        bytesReceived: num(r.bytesReceived) ?? 0,
      });
    }
  }
  const byPriority = (a: CandidateStat, b: CandidateStat) => (b.priority ?? 0) - (a.priority ?? 0);
  localCandidates.sort(byPriority);
  remoteCandidates.sort(byPriority);

  let selectedPair: SelectedPairStat | null = null;
  if (pair) {
    const local = byId.get(str(pair.localCandidateId));
    const remote = byId.get(str(pair.remoteCandidateId));
    const rtt = num(pair.currentRoundTripTime);
    selectedPair = {
      id: pair.id,
      state: str(pair.state),
      nominated: pair.nominated === true,
      local: local ? candidate(local) : null,
      remote: remote ? candidate(remote) : null,
      currentRoundTripTime: rtt === null ? null : rtt * 1000,
      availableOutgoingBitrate: num(pair.availableOutgoingBitrate),
      bytesSent: num(pair.bytesSent) ?? 0,
      bytesReceived: num(pair.bytesReceived) ?? 0,
      requestsSent: num(pair.requestsSent) ?? 0,
      requestsReceived: num(pair.requestsReceived) ?? 0,
      responsesSent: num(pair.responsesSent) ?? 0,
      responsesReceived: num(pair.responsesReceived) ?? 0,
    };
  }

  return { at: Date.now(), selectedPair, dataChannels, localCandidates, remoteCandidates };
}

// --- path classification ---------------------------------------------------------

function ipv4(addr: string): [number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(addr);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** 100.64.0.0/10 (Tailscale's CGNAT range) or its fd7a:115c:a1e0::/48 ULA. */
export function isTailscaleAddress(addr: string): boolean {
  const v4 = ipv4(addr);
  if (v4) return v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127;
  return /^fd7a:115c:a1e0:/i.test(addr);
}

export function isPrivateAddress(addr: string): boolean {
  const v4 = ipv4(addr);
  if (v4) {
    const [a, b] = v4;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const lower = addr.toLowerCase();
  return /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower) || lower === "::1";
}

/** Chrome hides its own host addresses behind random `<uuid>.local` mDNS names. */
export function isMdnsName(addr: string): boolean {
  return addr.endsWith(".local");
}

export type PathKind = "tailscale" | "lan" | "relay" | "internet";

export const PATH_LABELS: Record<PathKind, string> = {
  tailscale: "Direct via Tailscale",
  lan: "Direct (LAN)",
  relay: "Relayed (TURN)",
  internet: "Direct (internet)",
};

export function classifyPath(local: CandidateStat | null, remote: CandidateStat | null): PathKind | null {
  if (!local && !remote) return null;
  const addrs = [local?.address ?? "", remote?.address ?? ""];
  if (local?.type === "relay" || remote?.type === "relay") return "relay";
  if (addrs.some(isTailscaleAddress)) return "tailscale";
  // A masked (mDNS) local address counts as private if the far end is.
  const privateish = (a: string) => !a || isPrivateAddress(a) || isMdnsName(a);
  if (addrs.every(privateish) && addrs.some(isPrivateAddress)) return "lan";
  return "internet";
}
