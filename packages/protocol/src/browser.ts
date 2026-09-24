// Mirrors daemon/internal/protocol/browser.go.

/**
 * Browser channel `browser:<projectId>`: a Chromium tab on the device, shown
 * as a JPEG screencast. JSON text frames both ways; each daemon `frame` header
 * is followed by the JPEG as binary chunks totalling `size` bytes. The client
 * sends `attach` first. The last client to attach or resize sets the tab's
 * viewport.
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
  /** JPEG quality, 20-95. */
  quality: number;
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
  | { t: "copy" };

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
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
  | { t: "error"; message: string };
