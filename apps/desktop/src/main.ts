// Everywhere's desktop app: the web app in a window of its own, plus web
// tabs. A browser can't show most sites inside another page (they refuse
// frames); here a web tab is a <webview>, a page of its own, so they all load.
//
// The window only ever shows the app (EVERYWHERE_URL, or --url=); anything
// else it's sent to opens in the system's browser.

import * as fs from "node:fs";
import * as path from "node:path";
import { app, BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions, shell, type WebContents } from "electron";
import { type DesktopTunnelMsg, type DesktopWebEvent, WEBVIEW_DEVICE_PREF } from "@everywhere/protocol";
import { LoopbackProxy, Tunnels } from "./proxy";
import { checkNow, installNow, startUpdates, type UpdateState, updateState } from "./updater";
import { emulateDevice, favicon, isWebUrl, setUpWebPage, setUpWebSession, WEB_PARTITION } from "./web-tabs";

const DEFAULT_URL = "https://ai.replogle.dev";
const argUrl = process.argv.find((a) => a.startsWith("--url="))?.slice("--url=".length);
const APP_URL = argUrl || process.env.EVERYWHERE_URL || DEFAULT_URL;
const APP_ORIGIN = new URL(APP_URL).origin;

app.setName("Everywhere");

let win: BrowserWindow | null = null;

const isApp = (url: string) => {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
};

/** Messages from the app's own pages only. */
const fromApp = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => !!e.senderFrame && isApp(e.senderFrame.url);

// --- window placement ----------------------------------------------------------

interface Placement {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

const placementFile = () => path.join(app.getPath("userData"), "window.json");

function loadPlacement(): Placement {
  try {
    const p = JSON.parse(fs.readFileSync(placementFile(), "utf8")) as Placement;
    if (p.width >= 400 && p.height >= 300) return p;
  } catch {
    // first run
  }
  return { width: 1400, height: 900 };
}

function savePlacement(w: BrowserWindow) {
  const b = w.getNormalBounds();
  const p: Placement = { ...b, maximized: w.isMaximized() };
  try {
    fs.writeFileSync(placementFile(), JSON.stringify(p));
  } catch {
    // not worth failing over
  }
}

// --- the window ----------------------------------------------------------------

function offlinePage(reason: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta name="color-scheme" content="dark light">
<title>Everywhere</title>
<body style="font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><p>Couldn't reach ${esc(new URL(APP_URL).host)}.</p>
<p style="opacity:.6">${esc(reason)}</p><p><a href="${esc(APP_URL)}">Try again</a></p></div>`)}`;
}

function createWindow() {
  const p = loadPlacement();
  const w = new BrowserWindow({
    ...p,
    minWidth: 400,
    minHeight: 300,
    show: false,
    title: "Everywhere",
    backgroundColor: "#0b0b0c",
    autoHideMenuBar: true,
    webPreferences: {
      // Not __dirname: the bundler fixes that to the source folder.
      preload: path.join(app.getAppPath(), "dist", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: true,
      additionalArguments: [`--everywhere-version=${app.getVersion()}`],
    },
  });
  win = w;
  // The usual keys for the app's own developer tools (a web tab handles them for its page).
  w.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const mod = process.platform === "darwin" ? input.meta : input.control;
    const key = input.key.toLowerCase();
    if (key === "f12" || (mod && input.shift && !input.alt && key === "i")) {
      e.preventDefault();
      w.webContents.toggleDevTools();
    }
  });
  if (p.maximized) w.maximize();
  w.once("ready-to-show", () => w.show());
  w.on("close", () => savePlacement(w));
  w.on("closed", () => {
    if (win === w) win = null;
  });

  const wc = w.webContents;
  // The window stays on the app; other places open in the system's browser.
  wc.on("will-navigate", (e, url) => {
    if (isApp(url)) return;
    e.preventDefault();
    if (isWebUrl(url)) void shell.openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isApp(url)) return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    if (isWebUrl(url) || /^mailto:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The app relays tunnels: a reload or crash ends them (pages reconnect as they do).
  wc.on("did-start-navigation", (d) => d.isMainFrame && !d.isSameDocument && tunnels.closeAll());
  wc.on("render-process-gone", () => tunnels.closeAll());
  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    // -3: aborted (a navigation replaced it)
    if (isMainFrame && code !== -3 && isApp(url)) void wc.loadURL(offlinePage(desc));
  });

  void w.loadURL(APP_URL);
}

// --- devices' localhost ---------------------------------------------------------

/** Each web tab's device (by webContents id): whose localhost its page's localhost is. */
const tabDevices = new Map<number, string | null>();
/** The device a webview being attached named, until its page exists (the next web-contents-created). */
let attaching: string | null | undefined;
/** Which device each loopback host:port was last loaded for: where https to it goes. */
const recentLoopback = new Map<string, string | null>();

function setTabDevice(wc: WebContents, deviceId: string | null) {
  tabDevices.set(wc.id, deviceId);
  wc.once("destroyed", () => tabDevices.delete(wc.id));
}

/** Connections to devices' ports, relayed by the app window (only it has the devices' connections). */
const tunnels = new Tunnels((m: DesktopTunnelMsg) => {
  if (!win || win.webContents.isLoading() || !isApp(win.webContents.getURL())) {
    if (m.t === "open") setImmediate(() => tunnels.closed(m.id, "the app isn't open"));
    return;
  }
  win.webContents.send("ew:tunnel", m);
});

/** The app window's pages may only make web tabs: the web session, no preload, no Node. */
function guardWebviews(host: WebContents) {
  host.on("will-attach-webview", (e, prefs, params) => {
    if (!isApp(host.getURL()) || !(isWebUrl(params.src ?? "") || params.src === "about:blank")) {
      e.preventDefault();
      return;
    }
    // Which device the tab is: taken here, before its page exists or loads anything.
    const named = (prefs as Record<string, unknown>)[WEBVIEW_DEVICE_PREF];
    delete (prefs as Record<string, unknown>)[WEBVIEW_DEVICE_PREF];
    attaching = typeof named === "string" && named ? named : null;
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    // Opaque, as a browser tab is: a page with a dark color-scheme and no background gets a dark canvas.
    prefs.transparent = false;
    prefs.partition = WEB_PARTITION;
    params.partition = WEB_PARTITION;
  });
}

function emitWebEvent(e: DesktopWebEvent) {
  win?.webContents.send("ew:web-event", e);
}

// --- the menu ------------------------------------------------------------------

/** The menu's update item: what an update is doing, and the way to it. */
function updateItem(u: UpdateState): MenuItemConstructorOptions {
  switch (u.t) {
    case "ready":
      return { label: `Restart to update to ${u.version}`, click: installNow };
    case "downloading":
      return { label: `Downloading ${u.version} (${u.percent}%)…`, click: checkNow };
    case "checking":
      return { label: "Checking for updates…", enabled: false };
    default:
      return { label: "Check for updates…", click: checkNow };
  }
}

function setMenu() {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : [{ label: "File", submenu: [{ role: "quit" as const }] }]),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        // Not Ctrl+R: in a web tab that reloads the page (the tab handles it).
        { label: "Reload app", accelerator: "CmdOrCtrl+Shift+Alt+R", click: () => win?.webContents.reload() },
        // F12 and Ctrl+Shift+I work too (see createWindow); this one also works in a web tab.
        { label: "App developer tools", accelerator: "CmdOrCtrl+Shift+Alt+I", click: () => win?.webContents.toggleDevTools() },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    // Not the window menu's Ctrl+W: in a web tab that closes the tab.
    { label: "Window", submenu: [{ role: "minimize" }, ...(isMac ? [{ role: "zoom" as const }, { role: "front" as const }] : [])] },
    { label: "Help", submenu: [updateItem(updateState()), { label: `Version ${app.getVersion()}`, enabled: false }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- start ---------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on("web-contents-created", (_e, wc) => {
    if (wc.getType() === "webview") {
      setTabDevice(wc, attaching ?? null);
      attaching = undefined;
      setUpWebPage(wc, emitWebEvent, (popup, opener) => setTabDevice(popup, tabDevices.get(opener.id) ?? null));
      return;
    }
    guardWebviews(wc);
  });

  ipcMain.on("ew:open-external", (e, url: unknown) => {
    if (fromApp(e) && typeof url === "string" && (isWebUrl(url) || /^mailto:/i.test(url))) void shell.openExternal(url);
  });
  ipcMain.on("ew:tunnel-opened", (e, id: number) => fromApp(e) && tunnels.opened(id));
  ipcMain.on("ew:tunnel-data", (e, id: number, data: Uint8Array) => fromApp(e) && tunnels.data(id, data));
  ipcMain.on("ew:tunnel-closed", (e, id: number, error?: string) => fromApp(e) && tunnels.closed(id, error));
  ipcMain.on("ew:tunnel-pause", (e, id: number, paused: boolean) => fromApp(e) && tunnels.pause(id, !!paused));
  ipcMain.handle("ew:emulate", (e, id: unknown, mobile: unknown) =>
    fromApp(e) ? emulateDevice(e.sender, id, mobile) : "not allowed",
  );
  ipcMain.handle("ew:favicon", (e, url: unknown) => (fromApp(e) && typeof url === "string" ? favicon(url) : null));
  ipcMain.handle("ew:update-state", (e) => (fromApp(e) ? updateState() : null));
  ipcMain.on("ew:devtools", (e) => fromApp(e) && win?.webContents.toggleDevTools());
  ipcMain.on("ew:update-check", (e) => fromApp(e) && checkNow());
  ipcMain.on("ew:update-install", (e) => fromApp(e) && installNow());

  void app.whenReady().then(async () => {
    const proxy = new LoopbackProxy(tunnels, {
      deviceFor: (host, port) => recentLoopback.get(`${host}:${port}`) ?? null,
    });
    await setUpWebSession({
      proxyPort: await proxy.listen(),
      deviceOf: (id) => tabDevices.get(id) ?? null,
      loaded: (host, port, deviceId) => recentLoopback.set(`${host}:${port}`, deviceId),
    });
    setMenu();
    createWindow();
    // Progress is only shown at whole tens, so the menu isn't rebuilt per chunk.
    let shown = "";
    startUpdates((u) => {
      win?.webContents.send("ew:update", u);
      const key = u.t === "downloading" ? `${u.t} ${Math.floor(u.percent / 10)}` : u.t;
      if (key !== shown) {
        shown = key;
        setMenu();
      }
    });
    app.on("activate", () => {
      if (!win) createWindow();
    });
  });

  // Logging out signals the app: quit as usual, so a downloaded update installs.
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => app.quit());

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
