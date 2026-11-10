// Web tabs: the web app's <webview>s, each a page of the internet in a
// top-level context of its own (so sites that refuse frames still load)
// with a shared, persistent session: sign in once and every tab is.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  session,
  shell,
  type Session,
  type WebContents,
  webContents,
} from "electron";
import type { DesktopWebEvent, WebShortcut } from "@everywhere/protocol";
import { DEVICE_HEADER, isLoopback } from "./proxy";

export const WEB_PARTITION = "persist:web";

const isMac = process.platform === "darwin";
const FAVICON_MAX = 512 * 1024;

export function webSession(): Session {
  return session.fromPartition(WEB_PARTITION);
}

export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** The window a web tab is drawn in (a popup's own, or its webview's host's). */
function windowOf(wc: WebContents): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(wc.hostWebContents ?? wc) ?? undefined;
}

/**
 * Sets up the web session: a browser's user agent (without Electron's,
 * which some sign-ins refuse), permissions that are asked for, and the
 * proxy that takes each tab's loopback requests to its device.
 */
export async function setUpWebSession(opts: {
  proxyPort: number;
  /** The device a page's localhost is, by its webContents id (null: this machine's). */
  deviceOf(webContentsId: number): string | null;
  /** A page asked for a loopback host:port (for the proxy's https, which can't say). */
  loaded(host: string, port: number, deviceId: string | null): void;
}) {
  const ses = webSession();
  ses.setUserAgent(
    ses
      .getUserAgent()
      .split(" ")
      .filter((t) => !/^[^/()]+\/[\d.]+$/.test(t) || /^(Mozilla|AppleWebKit|Chrome|Safari)\//.test(t))
      .join(" "),
  );
  // Everything through the proxy (which passes all but loopback straight on):
  // Chromium never asks a PAC script about loopback hosts.
  await ses.setProxy({ mode: "fixed_servers", proxyRules: `127.0.0.1:${opts.proxyPort}`, proxyBypassRules: "<-loopback>" });

  const loopbackOf = (url: string): { host: string; port: number } | null => {
    try {
      const u = new URL(url);
      if (!isLoopback(u.hostname)) return null;
      const port = Number(u.port) || (u.protocol === "https:" || u.protocol === "wss:" ? 443 : 80);
      return { host: u.hostname, port };
    } catch {
      return null;
    }
  };
  ses.webRequest.onBeforeRequest((d, cb) => {
    const l = d.webContentsId !== undefined ? loopbackOf(d.url) : null;
    if (l) opts.loaded(l.host, l.port, opts.deviceOf(d.webContentsId!));
    cb({});
  });
  ses.webRequest.onBeforeSendHeaders((d, cb) => {
    const headers = d.requestHeaders;
    // Plain-text requests (http, ws) tell the proxy their tab's device; it takes the header off.
    if (/^(http|ws):/i.test(d.url) && d.webContentsId !== undefined && loopbackOf(d.url)) {
      const deviceId = opts.deviceOf(d.webContentsId);
      if (deviceId) headers[DEVICE_HEADER] = deviceId;
    }
    cb({ requestHeaders: headers });
  });

  setUpPermissions(ses);
}

// --- permissions -------------------------------------------------------------

const ALWAYS = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock", "keyboardLock"]);
const ASK: Record<string, string> = {
  media: "use your camera or microphone",
  geolocation: "know your location",
  notifications: "show notifications",
  "clipboard-read": "see what you copy",
  midi: "use your MIDI devices",
  midiSysex: "use your MIDI devices",
  "display-capture": "see your screen",
  "idle-detection": "know when you're away",
  "window-management": "manage windows on your displays",
  openExternal: "open another app",
};

function setUpPermissions(ses: Session) {
  const file = path.join(app.getPath("userData"), "permissions.json");
  let decided: Record<string, boolean> = {};
  try {
    decided = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, boolean>;
  } catch {
    // none yet
  }
  const save = () => fs.promises.writeFile(file, JSON.stringify(decided, null, 1)).catch(() => {});
  const origin = (url: string) => {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  };

  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (ALWAYS.has(permission)) return cb(true);
    const what = ASK[permission];
    if (!what) return cb(false);
    const o = origin(details.requestingUrl || wc?.getURL() || "");
    const key = `${o} ${permission}`;
    if (key in decided) return cb(decided[key]!);
    const win = wc ? windowOf(wc) : undefined;
    const opts = {
      type: "question" as const,
      buttons: ["Allow", "Block"],
      defaultId: 1,
      cancelId: 1,
      message: `${new URL(o).host || o} wants to ${what}`,
      checkboxLabel: "Remember this for the site",
      checkboxChecked: true,
    };
    void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then(({ response, checkboxChecked }) => {
      const allow = response === 0;
      if (checkboxChecked) {
        decided[key] = allow;
        void save();
      }
      cb(allow);
    });
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (ALWAYS.has(permission)) return true;
    return decided[`${origin(requestingOrigin)} ${permission}`] === true;
  });
}

// --- the pages ---------------------------------------------------------------

/**
 * A web tab's page (or a popup it opened): links meant for a new tab become
 * web tabs, popups (a sign-in window) stay windows, and the app's keys and
 * a browser's context menu work in it.
 */
export function setUpWebPage(
  wc: WebContents,
  emit: (e: DesktopWebEvent) => void,
  /** A popup the page opened (it belongs to the same device). */
  onPopup: (popup: WebContents, opener: WebContents) => void,
) {
  // A popup's links open as tabs from the tab that opened it.
  const tabOf = (w: WebContents): WebContents => (w.opener && webContents.fromFrame(w.opener)) || w;

  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (!isWebUrl(url)) {
      if (/^(mailto|tel|sms|zoommtg|slack|vscode|cursor|x-github-client):/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    }
    if (disposition === "new-window") {
      // A window.open with a size: a sign-in or payment popup that talks to its opener.
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 700,
          autoHideMenuBar: true,
          webPreferences: { partition: WEB_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    emit({ t: "open", from: tabOf(wc).id, url, background: disposition === "background-tab" });
    return { action: "deny" };
  });
  wc.on("did-create-window", (child) => {
    onPopup(child.webContents, wc);
    setUpWebPage(child.webContents, emit, onPopup);
  });

  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const action = shortcut(wc, input);
    if (!action) return;
    e.preventDefault();
    if (typeof action === "string") emit({ t: "shortcut", from: tabOf(wc).id, action });
    else action();
  });

  // Ctrl+wheel and pinches: the tab keeps its zoom, and shows it.
  wc.on("zoom-changed", (_e, direction) => {
    emit({ t: "shortcut", from: tabOf(wc).id, action: direction === "in" ? "zoom-in" : "zoom-out" });
  });

  wc.on("context-menu", (_e, p) => {
    const items: MenuItemConstructorOptions[] = [];
    const sep = () => items.length && items.at(-1)?.type !== "separator" && items.push({ type: "separator" });
    const newTab = (url: string) => emit({ t: "open", from: tabOf(wc).id, url, background: true });

    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      items.push({
        label: "Add to dictionary",
        click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord),
      });
      sep();
    }
    if (p.linkURL && isWebUrl(p.linkURL)) {
      items.push(
        { label: "Open link in new tab", click: () => newTab(p.linkURL) },
        { label: "Open link in browser", click: () => void shell.openExternal(p.linkURL) },
        { label: "Copy link address", click: () => clipboard.writeText(p.linkURL) },
      );
      sep();
    }
    if (p.mediaType === "image" && p.srcURL) {
      if (isWebUrl(p.srcURL)) items.push({ label: "Open image in new tab", click: () => newTab(p.srcURL) });
      items.push(
        { label: "Save image as…", click: () => wc.downloadURL(p.srcURL) },
        { label: "Copy image", click: () => wc.copyImageAt(p.x, p.y) },
        { label: "Copy image address", click: () => clipboard.writeText(p.srcURL) },
      );
      sep();
    }
    if (p.isEditable) {
      items.push(
        { role: "undo", enabled: p.editFlags.canUndo },
        { role: "redo", enabled: p.editFlags.canRedo },
        { type: "separator" },
        { role: "cut", enabled: p.editFlags.canCut },
        { role: "copy", enabled: p.editFlags.canCopy },
        { role: "paste", enabled: p.editFlags.canPaste },
        { role: "selectAll", enabled: p.editFlags.canSelectAll },
      );
      sep();
    } else if (p.selectionText.trim()) {
      const text = p.selectionText.trim();
      items.push(
        { role: "copy" },
        {
          label: `Search Google for “${text.length > 24 ? `${text.slice(0, 24)}…` : text}”`,
          click: () => newTab(`https://www.google.com/search?q=${encodeURIComponent(text)}`),
        },
      );
      sep();
    }
    if (!items.length) {
      const h = wc.navigationHistory;
      items.push(
        { label: "Back", enabled: h.canGoBack(), click: () => h.goBack() },
        { label: "Forward", enabled: h.canGoForward(), click: () => h.goForward() },
        { label: "Reload", click: () => wc.reload() },
        { type: "separator" },
        { label: "Open page in browser", enabled: isWebUrl(wc.getURL()), click: () => void shell.openExternal(wc.getURL()) },
      );
      sep();
    }
    items.push({ label: "Inspect", click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: windowOf(wc) });
  });
}

/** The app's keys in a page: an action for the app (a string), or one done here. */
function shortcut(wc: WebContents, input: Electron.Input): WebShortcut | (() => void) | null {
  const mod = isMac ? input.meta : input.control;
  const key = input.key.toLowerCase();
  const h = wc.navigationHistory;
  if ((mod && !input.shift && key === "l") || key === "f6" || (!isMac && input.alt && key === "d")) return "focus-address";
  if (mod && !input.shift && key === "f") return "find";
  if (mod && !input.shift && key === "t") return "new-tab";
  if (mod && !input.shift && key === "w") return "close-tab";
  if (mod && (key === "=" || key === "+")) return "zoom-in";
  if (mod && key === "-") return "zoom-out";
  if (mod && key === "0") return "zoom-reset";
  if ((mod && key === "r") || key === "f5") return () => (input.shift ? wc.reloadIgnoringCache() : wc.reload());
  if ((input.alt && !mod && key === "arrowleft") || (isMac && input.meta && key === "[")) return () => h.goBack();
  if ((input.alt && !mod && key === "arrowright") || (isMac && input.meta && key === "]")) return () => h.goForward();
  if (key === "f12" || (mod && input.shift && key === "i")) return () => wc.toggleDevTools();
  if (key === "escape" && wc.isLoading()) return () => wc.stop();
  return null;
}

// --- device emulation ----------------------------------------------------------

/** Chrome for Android's user agent, from desktop Chrome's (as the daemon's browser tab does). */
function mobileUA(ua: string): string {
  return ua.replace(/\([^)]*\)/, "(Linux; Android 10; K)").replace(" Safari/", " Mobile Safari/");
}

/**
 * Makes a web tab a phone, as Chrome's device toolbar does, through the
 * page's debugger: a mobile viewport (meta viewport, no scrollbars), touch
 * support, and a phone's user agent. Not touch events for the mouse: in a
 * <webview> they keep hold of the mouse, losing the app's next click. null undoes it all (the
 * overrides go with the debugger). The size of the page itself is the
 * <webview>'s, which the app sets.
 */
export async function emulateDevice(host: WebContents, id: unknown, mobile: unknown): Promise<string | null> {
  const wc = typeof id === "number" ? webContents.fromId(id) : undefined;
  // Only the asking window's own web tabs.
  if (!wc || wc.getType() !== "webview" || wc.hostWebContents !== host) return "no such tab";
  const dbg = wc.debugger;
  const m = mobile as { width?: unknown; height?: unknown } | null;
  try {
    if (!m) {
      if (!dbg.isAttached()) return null;
      dbg.detach();
      wc.reload();
      return null;
    }
    const width = Math.round(Number(m.width));
    const height = Math.round(Number(m.height));
    if (!(width >= 200 && width <= 3840 && height >= 200 && height <= 3840)) return "bad size";
    const fresh = !dbg.isAttached();
    if (fresh) dbg.attach("1.3");
    await dbg.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 0, mobile: true });
    if (fresh) {
      await dbg.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await dbg.sendCommand("Emulation.setUserAgentOverride", { userAgent: mobileUA(webSession().getUserAgent()) });
      // Sites read the user agent and touch support as they load.
      wc.reload();
    }
    return null;
  } catch (e) {
    // e.g. the page's own developer tools hold its debugger.
    return e instanceof Error ? e.message : String(e);
  }
}

// --- favicons ----------------------------------------------------------------

const favicons = new Map<string, Promise<string | null>>();

/** A favicon as a data: URL (the app's pages only show images from data: URLs and their own origin). */
export function favicon(url: string): Promise<string | null> {
  if (!isWebUrl(url)) return Promise.resolve(null);
  let p = favicons.get(url);
  if (!p) {
    p = (async () => {
      try {
        const res = await webSession().fetch(url, { signal: AbortSignal.timeout(8000) });
        const type = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/x-icon";
        if (!res.ok || !/^image\//.test(type)) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length || buf.length > FAVICON_MAX) return null;
        return `data:${type};base64,${buf.toString("base64")}`;
      } catch {
        return null;
      }
    })();
    favicons.set(url, p);
    if (favicons.size > 500) favicons.delete(favicons.keys().next().value!);
  }
  return p;
}
