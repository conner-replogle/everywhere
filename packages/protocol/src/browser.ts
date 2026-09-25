// Mirrors daemon/internal/protocol/browser.go.

import type { IceCandidate } from "./index";

/**
 * Browser channel `browser:<threadId>`: a Chromium tab on the device. JSON
 * text frames both ways; the client sends `attach` first. A client that
 * attaches with `video` then sends an `offer` and gets the tab as WebRTC
 * video on a peer connection of its own, signaled here (`answer`, `ice` both
 * ways). Otherwise, or after `novideo`, it gets a JPEG screencast: each
 * daemon `frame` header is followed by the JPEG as binary chunks totalling
 * `size` bytes. While the tab's viewport mode is `fill`, the last client to
 * attach or resize sets its size.
 */
export const BROWSER_CHANNEL_PREFIX = "browser:";

/** Bitmask for `modifiers`, as in CDP. */
export const BrowserModifier = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

export interface BrowserViewport {
  /** CSS pixels. */
  width: number;
  height: number;
  /** Device pixel ratio the frames are rendered at (1-2). */
  dpr: number;
  /** Quality, 20-95: JPEG quality, or the video's bitrate cap. */
  quality: number;
  /** A touch device: emulate one while the tab fills the view. */
  mobile?: boolean;
  /** Wants WebRTC video instead of JPEG frames. */
  video?: boolean;
}

export type BrowserViewportMode = "fill" | "preset" | "freeform";

/** How the tab's viewport is sized. */
export interface BrowserViewportSetting {
  mode: BrowserViewportMode;
  /** Preset id, for mode `preset`. */
  preset?: string;
  /** Emulated size in CSS pixels; for `fill`, the viewer's. */
  width: number;
  height: number;
  /** Touch input and mobile layout rules. */
  mobile: boolean;
}

export interface BrowserTouchPoint {
  id: number;
  x: number;
  y: number;
}

/** A page element, for annotations and agent tools. Rect in viewport CSS pixels. */
export interface BrowserElement {
  tag: string;
  id?: string;
  classes?: string[];
  selector: string;
  role?: string;
  /** Accessible name, or text. */
  name?: string;
  text?: string;
  attrs?: Record<string, string>;
  /** React component chain, innermost first ("Button < Toolbar < App"). */
  component?: string;
  /** file:line, when React exposes it. */
  source?: string;
  styles?: Record<string, string>;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserClientMsg =
  | ({ t: "attach" } & BrowserViewport)
  | ({ t: "resize" } & BrowserViewport)
  /** http, https or about:blank. */
  | { t: "navigate"; url: string }
  | { t: "back" }
  | { t: "forward" }
  | { t: "reload" }
  | { t: "stop" }
  /** x/y in CSS pixels of the viewport; button/buttons as in DOM MouseEvent. */
  | {
      t: "mouse";
      kind: "move" | "down" | "up" | "wheel";
      x: number;
      y: number;
      button?: number;
      buttons?: number;
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  /** `text` is set for keys that insert it. */
  | {
      t: "key";
      kind: "down" | "up";
      key: string;
      code: string;
      keyCode: number;
      text?: string;
      location?: number;
      repeat?: boolean;
      modifiers?: number;
    }
  /** Inserts text as if typed (IME, paste, soft keyboards). */
  | { t: "text"; text: string }
  /** Asks for the page's selection; answered with `clipboard`. */
  | { t: "copy" }
  | {
      t: "viewport";
      mode: BrowserViewportMode;
      preset?: string;
      orientation?: "portrait" | "landscape";
      width?: number;
      height?: number;
    }
  /** "" follows the system. */
  | { t: "appearance"; colorScheme: "light" | "dark" | "" }
  /** `points`: the touches still down (for `end`, the ones that stay down). */
  | { t: "touch"; kind: "start" | "move" | "end" | "cancel"; points?: BrowserTouchPoint[]; modifiers?: number }
  /** Answered with `picked`: the element at x/y. */
  | { t: "pick"; id: number; x: number; y: number }
  /** A receive-only video offer; answered with `answer` or `novideo`. Another replaces it. */
  | { t: "offer"; sdp: string }
  | { t: "ice"; candidate: IceCandidate };

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Emulated prefers-color-scheme; "" for none. Absent on older daemons. */
  colorScheme?: "light" | "dark" | "";
  viewport?: BrowserViewportSetting;
  /** A text field in the page has focus. */
  editing?: boolean;
}

export type BrowserDaemonMsg =
  /** Width and height: the viewport in CSS pixels that the image covers. */
  | { t: "frame"; seq: number; size: number; width: number; height: number }
  | ({ t: "state" } & BrowserState)
  /** The CSS cursor under the pointer. */
  | { t: "cursor"; cursor: string }
  | { t: "clipboard"; text: string }
  /** Something the stream can't show, like a dialog answered automatically. */
  | { t: "notice"; message: string }
  | { t: "error"; message: string }
  | { t: "picked"; id: number; element: BrowserElement | null }
  | { t: "answer"; sdp: string }
  /** The device's candidate for the video; can come before the answer. */
  | { t: "ice"; candidate: IceCandidate }
  /** Video isn't available (any more): JPEG frames follow. */
  | { t: "novideo"; message: string }
  /** What an agent is doing in the tab, at x/y when it has a position. */
  | { t: "agent"; action: string; x?: number; y?: number; label?: string };
