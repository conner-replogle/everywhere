// The browser:<projectId> channel: reassembles screencast frames (a JSON
// header, then the JPEG in binary chunks) and carries input the other way.

import type { BrowserClientMsg, BrowserDaemonMsg } from "@everywhere/protocol";

export type BrowserFrameHeader = Extract<BrowserDaemonMsg, { t: "frame" }>;

export interface BrowserHandlers {
  onOpen(): void;
  onFrame(hdr: BrowserFrameHeader, jpeg: Uint8Array<ArrayBuffer>): void;
  onMessage(msg: Exclude<BrowserDaemonMsg, { t: "frame" }>): void;
  onClose(): void;
}

export class BrowserChannel {
  private closed = false;
  private frame: { hdr: BrowserFrameHeader; buf: Uint8Array<ArrayBuffer>; got: number } | null = null;

  constructor(
    private ch: RTCDataChannel,
    h: BrowserHandlers,
  ) {
    ch.binaryType = "arraybuffer";
    ch.onopen = () => {
      if (!this.closed) h.onOpen();
    };
    ch.onmessage = (ev) => {
      if (this.closed) return;
      if (ev.data instanceof ArrayBuffer) {
        const f = this.frame;
        if (!f) return;
        const chunk = new Uint8Array(ev.data);
        f.buf.set(chunk.subarray(0, f.buf.length - f.got), f.got);
        f.got += chunk.length;
        if (f.got >= f.buf.length) {
          this.frame = null;
          h.onFrame(f.hdr, f.buf);
        }
        return;
      }
      let msg: BrowserDaemonMsg;
      try {
        msg = JSON.parse(ev.data as string) as BrowserDaemonMsg;
      } catch {
        return;
      }
      if (msg.t === "frame") {
        this.frame = { hdr: msg, buf: new Uint8Array(msg.size), got: 0 };
        if (msg.size === 0) this.frame = null;
      } else {
        h.onMessage(msg);
      }
    };
    ch.onclose = () => {
      if (this.closed) return;
      this.closed = true;
      h.onClose();
    };
  }

  get isOpen(): boolean {
    return !this.closed && this.ch.readyState === "open";
  }

  send(msg: BrowserClientMsg): void {
    if (this.isOpen) this.ch.send(JSON.stringify(msg));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ch.close();
  }
}
