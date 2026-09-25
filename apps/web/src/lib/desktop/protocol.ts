// Messages on a remote desktop session's own data channels: binary,
// little-endian, first byte is the type. Mirrors daemon/internal/desktop/wire.
// Receivers ignore unknown types and trailing bytes, so fields can be added.

export const CHANNEL_INPUT = "input"; // unordered, maxRetransmits: 0 (pointer motion)
export const CHANNEL_CONTROL = "control"; // reliable, ordered

export const Type = {
  // viewer → host
  Move: 0x01,
  Button: 0x02,
  Scroll: 0x03,
  Key: 0x04,
  ReleaseAll: 0x05,
  Ping: 0x06,
  SelectOutput: 0x07,
  SetMode: 0x08,
  Workspace: 0x09,
  SetFollow: 0x0a,
  SelectWindow: 0x0b,
  FocusWindow: 0x0c,
  Clipboard: 0x0d,
  SetClipSync: 0x0e,
  // host → viewer
  Hello: 0x80,
  CursorImage: 0x81,
  CursorPosition: 0x82,
  Outputs: 0x83,
  ModeInfo: 0x84,
  SessionEnded: 0x85,
  Pong: 0x86,
  PeerInfo: 0x87,
  Workspaces: 0x88,
  Windows: 0x89,
  HostClipboard: 0x8a,
} as const;

/** Clipboard text is capped both ways; bigger SCTP messages aren't portable. */
export const MAX_CLIPBOARD = 200 * 1024;

/** Sharp: native size, up to 40 Mbps. Smooth: ≤1080p60. Low: ≤720p30, ≤3 Mbps. */
export type DesktopMode = "sharp" | "smooth" | "low";

export const MODES: readonly DesktopMode[] = ["sharp", "smooth", "low"];

export const MODE_LABELS: Record<DesktopMode, string> = { sharp: "Sharp", smooth: "Smooth", low: "Low bandwidth" };

export const CODEC_NAMES = ["H.264", "H.265", "AV1"];

export const EndReason = { TakenOver: 1, HostShutdown: 2, CaptureError: 3 } as const;

/**
 * What is being captured and its native size: a whole monitor (window "")
 * or one window, which is then on `output`.
 */
export interface Hello {
  type: typeof Type.Hello;
  width: number;
  height: number;
  output: string;
  window: string;
  class: string;
  title: string;
}

export interface Pong {
  type: typeof Type.Pong;
  seq: number;
  clientMs: number;
  hostUs: number;
}

/** width = height = 0: the host cursor has no capturable image; show a default cursor. */
export interface CursorImage {
  type: typeof Type.CursorImage;
  width: number;
  height: number;
  hotX: number;
  hotY: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface CursorPosition {
  type: typeof Type.CursorPosition;
  /** False when the pointer is on another monitor. */
  inside: boolean;
  /** 0..1 across the video frame. */
  x: number;
  y: number;
}

export interface OutputInfo {
  name: string;
  width: number;
  height: number;
  active: boolean;
}

export interface Outputs {
  type: typeof Type.Outputs;
  outputs: OutputInfo[];
}

/** What the host is actually sending. */
export interface ModeInfo {
  type: typeof Type.ModeInfo;
  mode: DesktopMode;
  codec: number;
  width: number;
  height: number;
  bitrateKbps: number;
}

export interface SessionEnded {
  type: typeof Type.SessionEnded;
  reason: number;
  /** Who took over, or the capture error. */
  detail: string;
}

/** How the host sees the viewer: whether traffic is relayed (TURN or Tailscale DERP). */
export interface PeerInfo {
  type: typeof Type.PeerInfo;
  relayed: boolean;
  relay: string;
  device: string;
}

export interface WorkspaceInfo {
  id: number;
  name: string;
  monitor: string;
  windows: number;
  /** Shown on its monitor. */
  active: boolean;
  /** Its monitor has focus. */
  focused: boolean;
}

/** The host's regular workspaces, sorted by id; sent whenever they change. */
export interface Workspaces {
  type: typeof Type.Workspaces;
  workspaces: WorkspaceInfo[];
}

export interface WindowInfo {
  /** Hyprland's stableId. */
  id: string;
  class: string;
  title: string;
  workspace: string;
  monitor: string;
  focused: boolean;
}

/** The host's windows, by workspace; sent whenever they change. */
export interface Windows {
  type: typeof Type.Windows;
  windows: WindowInfo[];
}

export interface HostClipboard {
  type: typeof Type.HostClipboard;
  text: string;
}

export type HostMessage =
  | Hello
  | Pong
  | CursorImage
  | CursorPosition
  | Outputs
  | ModeInfo
  | SessionEnded
  | PeerInfo
  | Workspaces
  | Windows
  | HostClipboard;

/** Reads a u8-length-prefixed UTF-8 string; returns it and the offset after it. */
function shortString(data: ArrayBuffer, off: number): [string, number] {
  const b = new DataView(data);
  if (off >= b.byteLength) return ["", off];
  const len = Math.min(b.getUint8(off), b.byteLength - off - 1);
  return [new TextDecoder().decode(new Uint8Array(data, off + 1, len)), off + 1 + len];
}

const clamp16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v * 65535)));

/** x, y are normalized 0..1 across the video frame. */
export function move(seq: number, x: number, y: number): ArrayBuffer {
  const b = new DataView(new ArrayBuffer(7));
  b.setUint8(0, Type.Move);
  b.setUint16(1, seq & 0xffff, true);
  b.setUint16(3, clamp16(x), true);
  b.setUint16(5, clamp16(y), true);
  return b.buffer;
}

/** btn is a DOM MouseEvent.button value. */
export function button(btn: number, pressed: boolean, x: number, y: number): ArrayBuffer {
  const b = new DataView(new ArrayBuffer(7));
  b.setUint8(0, Type.Button);
  b.setUint8(1, btn);
  b.setUint8(2, pressed ? 1 : 0);
  b.setUint16(3, clamp16(x), true);
  b.setUint16(5, clamp16(y), true);
  return b.buffer;
}

/** continuous: dx/dy in pixels (touchpad); otherwise wheel notches. */
export function scroll(continuous: boolean, dx: number, dy: number): ArrayBuffer {
  const b = new DataView(new ArrayBuffer(10));
  b.setUint8(0, Type.Scroll);
  b.setUint8(1, continuous ? 1 : 0);
  b.setFloat32(2, dx, true);
  b.setFloat32(6, dy, true);
  return b.buffer;
}

/** code is a Linux KEY_* code for the physical key. */
export function key(code: number, pressed: boolean): ArrayBuffer {
  const b = new DataView(new ArrayBuffer(4));
  b.setUint8(0, Type.Key);
  b.setUint16(1, code, true);
  b.setUint8(3, pressed ? 1 : 0);
  return b.buffer;
}

export function releaseAll(): ArrayBuffer {
  return new Uint8Array([Type.ReleaseAll]).buffer;
}

export function ping(seq: number, clientMs: number): ArrayBuffer {
  const b = new DataView(new ArrayBuffer(13));
  b.setUint8(0, Type.Ping);
  b.setUint32(1, seq >>> 0, true);
  b.setFloat64(5, clientMs, true);
  return b.buffer;
}

function withShortString(type: number, s: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(s).slice(0, 255);
  const b = new Uint8Array(2 + bytes.length);
  b[0] = type;
  b[1] = bytes.length;
  b.set(bytes, 2);
  return b.buffer;
}

/** Captures a whole monitor. */
export function selectOutput(name: string): ArrayBuffer {
  return withShortString(Type.SelectOutput, name);
}

/** Captures one window; input then only reaches it. */
export function selectWindow(id: string): ArrayBuffer {
  return withShortString(Type.SelectWindow, id);
}

/** Focuses a window on the host, switching to its workspace. */
export function focusWindow(id: string): ArrayBuffer {
  return withShortString(Type.FocusWindow, id);
}

/** Puts text on the host's clipboard. Null if it's too big to send. */
export function clipboard(text: string): ArrayBuffer | null {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_CLIPBOARD) return null;
  const b = new Uint8Array(5 + bytes.length);
  b[0] = Type.Clipboard;
  new DataView(b.buffer).setUint32(1, bytes.length, true);
  b.set(bytes, 5);
  return b.buffer;
}

/** Clipboard exchange is off until the viewer turns it on. */
export function setClipSync(on: boolean): ArrayBuffer {
  return new Uint8Array([Type.SetClipSync, on ? 1 : 0]).buffer;
}

/** Switches the host to a workspace; Hyprland focuses the monitor it's on. */
export function workspace(id: number): ArrayBuffer {
  const b = new DataView(new ArrayBuffer(5));
  b.setUint8(0, Type.Workspace);
  b.setInt32(1, id, true);
  return b.buffer;
}

/** Following: the host captures whichever monitor has focus. */
export function setFollow(on: boolean): ArrayBuffer {
  return new Uint8Array([Type.SetFollow, on ? 1 : 0]).buffer;
}

export function setMode(mode: DesktopMode): ArrayBuffer {
  return new Uint8Array([Type.SetMode, MODES.indexOf(mode)]).buffer;
}

export function parseHost(data: ArrayBuffer): HostMessage | null {
  const b = new DataView(data);
  if (b.byteLength < 1) return null;
  switch (b.getUint8(0)) {
    case Type.Hello: {
      if (b.byteLength < 6) return null;
      const [output, o1] = shortString(data, 5);
      const [window, o2] = shortString(data, o1);
      const [cls, o3] = shortString(data, o2);
      const [title] = shortString(data, o3);
      return { type: Type.Hello, width: b.getUint16(1, true), height: b.getUint16(3, true), output, window, class: cls, title };
    }
    case Type.Windows: {
      if (b.byteLength < 2) return null;
      const windows: WindowInfo[] = [];
      let off = 2;
      for (let i = 0; i < b.getUint8(1) && off < b.byteLength; i++) {
        const fields: string[] = [];
        for (let f = 0; f < 5; f++) {
          const [v, next] = shortString(data, off);
          fields.push(v);
          off = next;
        }
        if (off >= b.byteLength) break;
        const flags = b.getUint8(off++);
        const [id = "", cls = "", title = "", workspace = "", monitor = ""] = fields;
        windows.push({ id, class: cls, title, workspace, monitor, focused: (flags & 1) !== 0 });
      }
      return { type: Type.Windows, windows };
    }
    case Type.HostClipboard: {
      if (b.byteLength < 5) return null;
      const len = Math.min(b.getUint32(1, true), b.byteLength - 5);
      return { type: Type.HostClipboard, text: new TextDecoder().decode(new Uint8Array(data, 5, len)) };
    }
    case Type.CursorImage: {
      if (b.byteLength < 9) return null;
      const width = b.getUint16(1, true);
      const height = b.getUint16(3, true);
      if (b.byteLength < 9 + width * height * 4) return null;
      return {
        type: Type.CursorImage,
        width,
        height,
        hotX: b.getUint16(5, true),
        hotY: b.getUint16(7, true),
        rgba: new Uint8ClampedArray(data, 9, width * height * 4),
      };
    }
    case Type.CursorPosition:
      if (b.byteLength < 6) return null;
      return {
        type: Type.CursorPosition,
        inside: b.getUint8(1) !== 0,
        x: b.getUint16(2, true) / 65535,
        y: b.getUint16(4, true) / 65535,
      };
    case Type.Outputs: {
      if (b.byteLength < 2) return null;
      const outputs: OutputInfo[] = [];
      let off = 2;
      for (let i = 0; i < b.getUint8(1) && off + 6 <= b.byteLength; i++) {
        const len = b.getUint8(off + 5);
        if (off + 6 + len > b.byteLength) break;
        outputs.push({
          active: b.getUint8(off) !== 0,
          width: b.getUint16(off + 1, true),
          height: b.getUint16(off + 3, true),
          name: new TextDecoder().decode(new Uint8Array(data, off + 6, len)),
        });
        off += 6 + len;
      }
      return { type: Type.Outputs, outputs };
    }
    case Type.ModeInfo:
      if (b.byteLength < 11) return null;
      return {
        type: Type.ModeInfo,
        mode: MODES[b.getUint8(1)] ?? "sharp",
        codec: b.getUint8(2),
        width: b.getUint16(3, true),
        height: b.getUint16(5, true),
        bitrateKbps: b.getUint32(7, true),
      };
    case Type.SessionEnded:
      if (b.byteLength < 2) return null;
      return { type: Type.SessionEnded, reason: b.getUint8(1), detail: shortString(data, 2)[0] };
    case Type.PeerInfo: {
      if (b.byteLength < 2) return null;
      const [relay, off] = shortString(data, 2);
      return { type: Type.PeerInfo, relayed: b.getUint8(1) !== 0, relay, device: shortString(data, off)[0] };
    }
    case Type.Workspaces: {
      if (b.byteLength < 2) return null;
      const workspaces: WorkspaceInfo[] = [];
      let off = 2;
      for (let i = 0; i < b.getUint8(1) && off + 7 <= b.byteLength; i++) {
        const id = b.getInt32(off, true);
        const windows = b.getUint16(off + 4, true);
        const flags = b.getUint8(off + 6);
        const [monitor, next] = shortString(data, off + 7);
        const [name, end] = shortString(data, next);
        workspaces.push({ id, windows, monitor, name, active: (flags & 1) !== 0, focused: (flags & 2) !== 0 });
        off = end;
      }
      return { type: Type.Workspaces, workspaces };
    }
    case Type.Pong:
      if (b.byteLength < 17) return null;
      return {
        type: Type.Pong,
        seq: b.getUint32(1, true),
        clientMs: b.getFloat64(5, true),
        hostUs: b.getUint32(13, true),
      };
  }
  return null;
}
