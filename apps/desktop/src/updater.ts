// Updates: the app checks the repo's latest GitHub release (the daemon's, a
// v* tag; .github/workflows/release.yml adds the installers and latest*.yml)
// at start, every few hours and on waking, downloads a newer version in the
// background, and installs it when the app quits, or at once from the
// notification or the menu.

import { app, dialog, Notification, powerMonitor } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_AFTER_MS = 10_000;

export type UpdateState =
  | { t: "idle" }
  | { t: "checking" }
  | { t: "downloading"; version: string; percent: number }
  | { t: "ready"; version: string }
  | { t: "error"; message: string };

let state: UpdateState = { t: "idle" };
let onChange: (s: UpdateState) => void = () => {};
/** A check the user asked for: say how it went, even if there's nothing new. */
let asked = false;

const set = (s: UpdateState) => {
  state = s;
  onChange(s);
};

/**
 * Whether this copy can update itself: a packaged build, and on Linux an
 * AppImage (a copy run from elsewhere has no file to replace).
 */
export function canUpdate(): boolean {
  return app.isPackaged && (process.platform !== "linux" || !!process.env.APPIMAGE);
}

export function updateState(): UpdateState {
  return state;
}

export function startUpdates(changed: (s: UpdateState) => void) {
  onChange = changed;
  if (!canUpdate()) return;
  // To try a build's updating: a folder served with a newer build and its latest*.yml.
  if (process.env.EVERYWHERE_UPDATE_URL) autoUpdater.setFeedURL({ provider: "generic", url: process.env.EVERYWHERE_UPDATE_URL });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: () => {},
    debug: () => {},
    warn: (m: unknown) => console.warn("[update]", m),
    error: (m: unknown) => console.error("[update]", m),
  };

  autoUpdater.on("checking-for-update", () => state.t !== "ready" && set({ t: "checking" }));
  autoUpdater.on("update-not-available", () => {
    if (state.t !== "ready") set({ t: "idle" });
    if (asked) void dialog.showMessageBox({ message: `Everywhere ${app.getVersion()} is the latest version.` });
    asked = false;
  });
  autoUpdater.on("update-available", (info: UpdateInfo) => set({ t: "downloading", version: info.version, percent: 0 }));
  autoUpdater.on("download-progress", (p) => {
    if (state.t === "downloading") set({ ...state, percent: Math.round(p.percent) });
  });
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    set({ t: "ready", version: info.version });
    asked = false;
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: `Everywhere ${info.version} is ready`,
      body: "Click to restart now, or it installs when you quit.",
    });
    n.on("click", installNow);
    n.show();
  });
  autoUpdater.on("error", (e: Error) => {
    if (state.t !== "ready") set({ t: "error", message: e.message });
    if (asked) void dialog.showMessageBox({ type: "error", message: "Couldn't check for updates", detail: e.message });
    asked = false;
  });

  const check = () => {
    if (state.t === "downloading" || state.t === "ready") return;
    autoUpdater.checkForUpdates().catch(() => {}); // reported by "error"
  };
  setTimeout(check, FIRST_CHECK_AFTER_MS);
  setInterval(check, CHECK_EVERY_MS);
  powerMonitor.on("resume", check);
}

/** The menu's "Check for updates…". */
export function checkNow() {
  if (!canUpdate()) {
    void dialog.showMessageBox({
      message: "This copy can't update itself",
      detail: "Only the installed app updates (on Linux, the AppImage).",
    });
    return;
  }
  if (state.t === "ready") return installNow();
  if (state.t === "downloading") {
    void dialog.showMessageBox({ message: `Downloading Everywhere ${state.version} (${state.percent}%)…` });
    return;
  }
  asked = true;
  autoUpdater.checkForUpdates().catch(() => {});
}

export function installNow() {
  if (state.t !== "ready") return;
  // Quits the app (windows close as usual) and starts the new version.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}
