// The desktop app's bridge (apps/desktop/src/preload.ts): what the web app
// can ask of Electron when it runs inside it, as window.everywhereDesktop.
// Absent in a browser.

/** Something a web tab's page did that the app should act on. `from` is the page's webContents id. */
export type DesktopWebEvent =
  /** The page opened a link in a new tab (target=_blank, a middle click, "Open link in new tab"). */
  | { t: "open"; from: number; url: string; background: boolean }
  /** A key the app handles was pressed while the page had focus. */
  | { t: "shortcut"; from: number; action: WebShortcut };

export type WebShortcut =
  | "focus-address"
  | "find"
  | "new-tab"
  | "close-tab"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset";

/**
 * The desktop app asking the web app for a connection to a device's port:
 * a web tab's page loading its device's localhost goes over a tcp: channel
 * of the device's peer connection, which only the web app has.
 */
export type DesktopTunnelMsg =
  | { t: "open"; id: number; deviceId: string; host: string; port: number }
  | { t: "data"; id: number; data: Uint8Array }
  | { t: "close"; id: number };

/**
 * The <webview> webpreferences key naming the device a web tab belongs to:
 * the device whose localhost the page's localhost means.
 */
export const WEBVIEW_DEVICE_PREF = "everywhereDevice";

export interface DesktopBridge {
  /** The desktop app's version. */
  version: string;
  platform: string;
  /** The session partition web tabs' <webview>s use (the only one the app lets them attach with). */
  partition: string;
  /** Subscribes to web tabs' events; returns the unsubscribe. */
  onWebEvent(fn: (e: DesktopWebEvent) => void): () => void;
  /** Opens a link in the system's browser. */
  openExternal(url: string): void;
  /** Subscribes to tunnel requests (the app has one subscriber); returns the unsubscribe. */
  onTunnel(fn: (m: DesktopTunnelMsg) => void): () => void;
  /** Answers to tunnel requests. */
  tunnel: {
    /** The device connected the port. */
    opened(id: number): void;
    data(id: number, data: Uint8Array): void;
    /** The connection ended, or couldn't be made (error). */
    closed(id: number, error?: string): void;
    /** Hold (or resume) what the page sends: the channel's buffer is full. */
    pause(id: number, paused: boolean): void;
  };
  /** Opens or closes the app window's developer tools. Missing in apps from before it. */
  devTools?(): void;
  /** A page's favicon as a data: URL (fetched with the web tabs' cookies), or null. */
  favicon(url: string): Promise<string | null>;
  /**
   * Makes a web tab's page a phone's (mobile layout, touch, a phone's user
   * agent) at this size in CSS pixels, or with null a computer's again; it
   * reloads when that changes. Resolves with an error message, or null.
   * Missing in apps from before it.
   */
  emulate?(webContentsId: number, mobile: { width: number; height: number } | null): Promise<string | null>;
  /** The app's own updates. Missing in apps from before it. */
  update?: {
    state(): Promise<DesktopUpdateState>;
    /** Subscribes to changes; returns the unsubscribe. */
    onChange(fn: (s: DesktopUpdateState) => void): () => void;
    /** Checks now, and says how it went. */
    check(): void;
    /** Restarts into a downloaded update. */
    install(): void;
  };
}

/**
 * Where the desktop app's update is. unsupported: this copy can't update
 * itself (a dev build, or on Linux not the AppImage).
 */
export type DesktopUpdateState =
  | { t: "unsupported" }
  | { t: "idle" }
  | { t: "checking" }
  | { t: "downloading"; version: string; percent: number }
  | { t: "ready"; version: string }
  | { t: "error"; message: string };
