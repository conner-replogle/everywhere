// In the desktop app, a web tab's page loading its device's localhost (a dev
// server, its hot reload) comes here: the desktop app asks for a connection
// to the device's port, and it goes over a tcp: channel of the device's peer
// connection (the tunnel plugin), which only the web app has.

import { TCP_CHANNEL_PREFIX, type DesktopBridge, type TcpClientMsg, type TcpDaemonMsg } from "@everywhere/protocol";
import { type DevicePeer, getPeer } from "./peer";

const CONNECT_WAIT_MS = 15_000;
/** Above this much unsent, the page's sending is held. */
const HIGH_WATER = 1 << 20;
/** SCTP messages above this size aren't safe across all browsers. */
const MAX_CHUNK = 16 * 1024;

/** Waits for the peer to be connected (it's asked to connect meanwhile). */
function connected(peer: DevicePeer): Promise<void> {
  if (peer.getSnapshot().state === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("couldn't connect to the device")), CONNECT_WAIT_MS);
    const done = (err?: Error) => {
      clearTimeout(timer);
      off();
      if (err) reject(err);
      else resolve();
    };
    const off = peer.subscribe(() => {
      const s = peer.getSnapshot();
      if (s.state === "connected") done();
      else if (s.state === "failed") done(new Error(s.error ?? "couldn't connect to the device"));
    });
  });
}

/** Relays the desktop app's tunnels for as long as the page lives. */
export function startDesktopTunnels(bridge: DesktopBridge): () => void {
  const channels = new Map<number, RTCDataChannel>();
  // Each tunnel holds its device's connection open.
  const releases = new Map<number, () => void>();

  const end = (id: number, error?: string) => {
    const ch = channels.get(id);
    channels.delete(id);
    releases.get(id)?.();
    releases.delete(id);
    if (ch) {
      ch.onclose = ch.onmessage = ch.onerror = ch.onbufferedamountlow = null;
      ch.close();
    }
    bridge.tunnel.closed(id, error);
  };

  const open = async (id: number, deviceId: string, host: string, port: number) => {
    const peer = getPeer(deviceId);
    releases.set(id, peer.acquire());
    let ch: RTCDataChannel;
    try {
      await connected(peer);
      if (!releases.has(id)) return; // closed meanwhile
      ch = peer.openChannel(`${TCP_CHANNEL_PREFIX}${id}`);
    } catch (e) {
      end(id, e instanceof Error ? e.message : String(e));
      return;
    }
    channels.set(id, ch);
    let isOpen = false;
    ch.bufferedAmountLowThreshold = HIGH_WATER / 4;
    ch.onopen = () => ch.send(JSON.stringify({ t: "dial", host, port } satisfies TcpClientMsg));
    ch.onbufferedamountlow = () => bridge.tunnel.pause(id, false);
    ch.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        bridge.tunnel.data(id, new Uint8Array(ev.data));
        return;
      }
      let msg: TcpDaemonMsg;
      try {
        msg = JSON.parse(ev.data as string) as TcpDaemonMsg;
      } catch {
        return;
      }
      if (msg.t === "open") {
        isOpen = true;
        bridge.tunnel.opened(id);
      } else if (msg.t === "end") end(id);
      else end(id, msg.message);
    };
    ch.onclose = () =>
      end(id, isOpen ? undefined : "the device closed the connection (is its everywhere up to date?)");
  };

  const send = (id: number, data: Uint8Array) => {
    const ch = channels.get(id);
    if (!ch || ch.readyState !== "open") return;
    for (let i = 0; i < data.length; i += MAX_CHUNK) ch.send(data.subarray(i, i + MAX_CHUNK) as Uint8Array<ArrayBuffer>);
    if (ch.bufferedAmount > HIGH_WATER) bridge.tunnel.pause(id, true);
  };

  const off = bridge.onTunnel((m) => {
    if (m.t === "open") void open(m.id, m.deviceId, m.host, m.port);
    else if (m.t === "data") send(m.id, m.data);
    else {
      // The page closed it: no answer needed.
      const ch = channels.get(m.id);
      channels.delete(m.id);
      releases.get(m.id)?.();
      releases.delete(m.id);
      if (ch) {
        ch.onclose = null;
        ch.close();
      }
    }
  });
  return () => {
    off();
    for (const id of [...channels.keys(), ...releases.keys()]) end(id, "the app closed");
  };
}
