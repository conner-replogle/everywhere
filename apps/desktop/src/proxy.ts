// Web tabs reach a device's localhost through this proxy. The web session
// sends every request here (Chromium only proxies loopback hosts with a
// fixed proxy, not a PAC script), and the proxy passes the internet straight
// through. Loopback requests go to the device whose thread the tab is in,
// over a tcp: channel of the web app's connection to it: a dev server, and
// its hot reload's websocket, as they are on the device.
//
// Which device: a request carries its tab's in a header (added by the web
// session, taken off here). https and websockets come as CONNECT tunnels; a
// websocket's handshake inside is plain text with the header, while TLS
// isn't, so https goes to the device the host:port was last loaded for.

import * as http from "node:http";
import * as net from "node:net";
import { Duplex } from "node:stream";
import type { DesktopTunnelMsg } from "@everywhere/protocol";

export const DEVICE_HEADER = "x-everywhere-device";

const OPEN_TIMEOUT_MS = 20_000;
/** The most a CONNECT's first request head can be before it's passed on as is. */
const MAX_HEAD = 64 * 1024;

export function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    h === "0.0.0.0" ||
    h === "::" ||
    /^127\.\d+\.\d+\.\d+$/.test(h)
  );
}

/** A connection to a device's port, relayed by the web app. Looks enough like a socket for http. */
class TunnelStream extends Duplex {
  private held: (() => void) | null = null;
  private paused = false;
  ended = false;

  constructor(
    readonly id: number,
    private send: (m: DesktopTunnelMsg) => void,
  ) {
    super({ allowHalfOpen: false });
  }

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
    this.send({ t: "data", id: this.id, data: new Uint8Array(chunk) });
    if (this.paused) this.held = () => cb();
    else cb();
  }

  _read() {}

  _destroy(err: Error | null, cb: (err?: Error | null) => void) {
    if (!this.ended) {
      this.ended = true;
      this.send({ t: "close", id: this.id });
    }
    cb(err);
  }

  pauseSending(paused: boolean) {
    this.paused = paused;
    if (!paused && this.held) {
      const resume = this.held;
      this.held = null;
      resume();
    }
  }

  // What http's client and agents call on a socket.
  setKeepAlive() {
    return this;
  }
  setNoDelay() {
    return this;
  }
  setTimeout(_ms: number, cb?: () => void) {
    if (cb) this.once("timeout", cb);
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

/** Connections to devices' ports, through the web app (see DesktopTunnelMsg). */
export class Tunnels {
  private next = 1;
  private streams = new Map<number, TunnelStream>();
  private opening = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

  constructor(private send: (m: DesktopTunnelMsg) => void) {}

  open(deviceId: string, host: string, port: number): Promise<TunnelStream> {
    const id = this.next++;
    const s = new TunnelStream(id, this.send);
    this.streams.set(id, s);
    s.once("close", () => this.streams.delete(id));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("the device didn't answer")), OPEN_TIMEOUT_MS);
      const fail = (e: Error) => {
        clearTimeout(timer);
        this.opening.delete(id);
        s.destroy();
        reject(e);
      };
      this.opening.set(id, {
        resolve: () => {
          clearTimeout(timer);
          this.opening.delete(id);
          resolve(s);
        },
        reject: fail,
      });
      this.send({ t: "open", id, deviceId, host, port });
    });
  }

  opened(id: number) {
    this.opening.get(id)?.resolve();
  }

  data(id: number, data: Uint8Array) {
    this.streams.get(id)?.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  closed(id: number, error?: string) {
    const o = this.opening.get(id);
    if (o) return o.reject(new Error(error || "the device closed the connection"));
    const s = this.streams.get(id);
    if (!s) return;
    s.ended = true;
    // An error ends it now; the port closing ends it once what came is read.
    if (error) s.destroy(new Error(error));
    else s.push(null);
  }

  pause(id: number, paused: boolean) {
    this.streams.get(id)?.pauseSending(paused);
  }

  /** Every connection ends: the app that relayed them reloaded. */
  closeAll() {
    for (const id of [...this.opening.keys()]) this.closed(id, "the app reloaded");
    for (const id of [...this.streams.keys()]) this.closed(id, "the app reloaded");
  }
}

export interface Router {
  /** The device a request that didn't say goes to (https), or null for this machine. */
  deviceFor(host: string, port: number): string | null;
}

export class LoopbackProxy {
  private server: http.Server;
  /** Connection pools to devices' ports, per device and host:port. */
  private agents = new Map<string, http.Agent>();

  constructor(
    private tunnels: Tunnels,
    private router: Router,
  ) {
    this.server = http.createServer((req, res) => void this.request(req, res));
    this.server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) =>
      void this.connect(req, socket, head),
    );
    // Clients' sockets erroring (a closed tab) mustn't take the app down.
    this.server.on("clientError", (_e, socket) => socket.destroy());
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve((this.server.address() as net.AddressInfo).port));
    });
  }

  /** Where a connection to host:port goes: a device's port through the tunnel, or this machine's. */
  private dial(deviceId: string | null, host: string, port: number): Promise<Duplex> {
    if (deviceId) return this.tunnels.open(deviceId, host, port);
    return new Promise((resolve, reject) => {
      const s = net.connect(port, host.replace(/^\[|\]$/g, ""));
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  }

  private agentFor(deviceId: string, host: string, port: number): http.Agent {
    const key = `${deviceId} ${host}:${port}`;
    let a = this.agents.get(key);
    if (!a) {
      a = new http.Agent({ keepAlive: true, maxSockets: 8 });
      // The agent asks for connections as it needs them: each a tcp: channel.
      (a as unknown as { createConnection: unknown }).createConnection = (
        _opts: unknown,
        cb: (err: Error | null, s?: Duplex) => void,
      ) => {
        this.tunnels.open(deviceId, host, port).then(
          (s) => cb(null, s),
          (e: Error) => cb(e),
        );
      };
      this.agents.set(key, a);
    }
    return a;
  }

  /** A plain http request (an absolute URL): passed on, to its device if it's a loopback one. */
  private async request(req: http.IncomingMessage, res: http.ServerResponse) {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const host = url.hostname;
    const port = Number(url.port) || 80;
    const headers = { ...req.headers };
    const named = headers[DEVICE_HEADER];
    delete headers[DEVICE_HEADER];
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const deviceId = isLoopback(host) ? (typeof named === "string" ? named : this.router.deviceFor(host, port)) : null;
    const up = http.request({
      host: host.replace(/^\[|\]$/g, ""),
      port,
      method: req.method,
      path: url.pathname + url.search,
      headers,
      ...(deviceId ? { agent: this.agentFor(deviceId, host, port) } : {}),
    });
    up.on("response", (r) => {
      res.writeHead(r.statusCode ?? 502, r.statusMessage, r.rawHeaders);
      r.pipe(res);
    });
    up.on("error", (e) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      res.end(errorPage(url.host, deviceId ? "the device" : "this computer", e.message));
    });
    req.pipe(up);
  }

  /** A CONNECT tunnel: https, or a websocket. */
  private async connect(req: http.IncomingMessage, client: net.Socket, head: Buffer) {
    client.on("error", () => client.destroy());
    const target = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? "");
    if (!target) return client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    const host = target[1]!;
    const port = Number(target[2]);

    if (!isLoopback(host)) {
      const up = net.connect(port, host);
      up.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) up.write(head);
        up.pipe(client);
        client.pipe(up);
      });
      up.on("error", () => {
        if (up.connecting) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        else client.destroy();
      });
      client.on("close", () => up.destroy());
      return;
    }

    // Loopback: what's first inside says which device (a websocket's handshake does).
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let first: Buffer;
    try {
      first = await firstRequest(client, head);
    } catch {
      return client.destroy();
    }
    let deviceId = this.router.deviceFor(host, port);
    const parsed = takeHeader(first, DEVICE_HEADER);
    if (parsed) {
      first = parsed.rest;
      deviceId = parsed.value;
    }
    let up: Duplex;
    try {
      up = await this.dial(deviceId, host, port);
    } catch {
      return client.destroy();
    }
    if (client.destroyed) return up.destroy();
    up.write(first);
    up.pipe(client);
    client.pipe(up);
    up.on("error", () => client.destroy());
    up.on("close", () => client.destroy());
    client.on("close", () => up.destroy());
  }
}

/**
 * The start of what a client sends in a tunnel: its whole first request
 * head if it's plain http (a websocket handshake), or whatever came first
 * otherwise (a TLS hello).
 */
function firstRequest(socket: net.Socket, head: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = head;
    const done = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.pause();
      resolve(buf);
    };
    const check = () => {
      if (!buf.length) return false;
      // Not text that starts like a request (TLS starts 0x16): nothing to read.
      if (!/^[A-Z]{3,10} /.test(buf.subarray(0, 11).toString("latin1"))) return true;
      return buf.includes("\r\n\r\n") || buf.length > MAX_HEAD;
    };
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (check()) done();
    };
    const onClose = () => reject(new Error("closed"));
    if (check()) return resolve(buf);
    socket.on("data", onData);
    socket.once("close", onClose);
  });
}

/** Takes a header out of a request head: its value and the request without it. */
export function takeHeader(buf: Buffer, name: string): { value: string; rest: Buffer } | null {
  const end = buf.indexOf("\r\n\r\n");
  if (end < 0) return null;
  const headText = buf.subarray(0, end).toString("latin1");
  const lines = headText.split("\r\n");
  const i = lines.findIndex((l, n) => n > 0 && l.toLowerCase().startsWith(`${name}:`));
  if (i < 0) return null;
  const value = lines[i]!.slice(name.length + 1).trim();
  lines.splice(i, 1);
  return { value, rest: Buffer.concat([Buffer.from(lines.join("\r\n"), "latin1"), buf.subarray(end)]) };
}

/** The page for a loopback address nothing answered on. */
function errorPage(host: string, where: string, detail: string): string {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta name="color-scheme" content="light dark"><title>${esc(host)}</title>
<body style="font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:32em;text-align:center"><h1 style="font-size:16px">Couldn't reach ${esc(host)} on ${where}</h1>
<p style="opacity:.7">Is the server running there? In a web tab, localhost is the thread's device.</p>
<p style="opacity:.5;font-size:12px">${esc(detail)}</p></div>`;
}
