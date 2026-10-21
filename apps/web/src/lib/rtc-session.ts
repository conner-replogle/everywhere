// Plugin sessions: a PeerConnection of its own to the daemon (for media),
// signaled over the device connection's control channel instead of the hub.
// The browser offers; the plugin answers; candidates trickle both ways. The
// daemon's candidates can arrive before the answer (naming a session we
// don't know yet), so they're held until then, and ours wait for the id.

import type { IceCandidate, RpcEvent } from "@everywhere/protocol";
import type { DevicePeer } from "./peer";

/** How a kind of session is signaled. */
export interface SessionSignaling {
  start(sdp: string): Promise<{ id: string; sdp: string }>;
  candidate(id: string, candidate: IceCandidate): void;
  stop(id: string): void;
  /** One of the daemon's candidates, if the event is one. */
  theirCandidate(e: RpcEvent): { id: string; candidate: IceCandidate } | null;
  /** The id of a session the daemon ended, if the event says so. */
  ended?(e: RpcEvent): { id: string; reason?: string } | null;
}

/** Signaling for rtc.open sessions (devices with feature "plugins"). */
export function rtcSignaling(peer: DevicePeer, kind: string, params: unknown, timeoutMs: number): SessionSignaling {
  return {
    start: (sdp) => peer.call("rtc.open", { kind, sdp, params }, timeoutMs),
    candidate: (id, candidate) => void peer.call("rtc.candidate", { id, candidate }).catch(() => {}),
    stop: (id) => void peer.call("rtc.close", { id }).catch(() => {}),
    theirCandidate: (e) => (e.event === "rtc.candidate" ? { id: e.id, candidate: e.candidate } : null),
    ended: (e) => (e.event === "rtc.closed" ? { id: e.id, reason: e.reason } : null),
  };
}

export interface Session {
  id: string;
  close(): void;
}

/**
 * Negotiates pc (with its transceivers and channels already added) over
 * sig. onEnded is called if the daemon ends the session.
 */
export async function negotiate(
  peer: DevicePeer,
  pc: RTCPeerConnection,
  sig: SessionSignaling,
  onEnded?: (reason?: string) => void,
): Promise<Session> {
  let id: string | null = null;
  let answered = false;
  const theirs: { id: string; candidate: RTCIceCandidateInit }[] = [];
  const ours: IceCandidate[] = [];
  const sendOurs = (candidate: IceCandidate) => {
    if (id) sig.candidate(id, candidate);
    else ours.push(candidate);
  };
  pc.onicecandidate = (ev) => {
    const c = ev.candidate?.toJSON();
    if (c?.candidate) sendOurs({ ...c, candidate: c.candidate });
  };
  const unsubscribe = peer.onEvent((e) => {
    const end = sig.ended?.(e);
    if (end && end.id === id) {
      onEnded?.(end.reason);
      return;
    }
    const c = sig.theirCandidate(e);
    if (!c || (id && c.id !== id)) return;
    if (answered) void pc.addIceCandidate(c.candidate).catch(() => {});
    else theirs.push(c);
  });

  try {
    await pc.setLocalDescription(await pc.createOffer());
    const started = await sig.start(pc.localDescription?.sdp ?? "");
    id = started.id;
    await pc.setRemoteDescription({ type: "answer", sdp: started.sdp });
    answered = true;
    for (const c of theirs) if (c.id === id) await pc.addIceCandidate(c.candidate).catch(() => {});
    for (const c of ours.splice(0)) sendOurs(c);
  } catch (e) {
    unsubscribe();
    if (id) sig.stop(id);
    throw e;
  }
  const sessionId = id;
  return {
    id: sessionId,
    close() {
      unsubscribe();
      sig.stop(sessionId);
    },
  };
}
