// The app window's bridge to Electron: window.everywhereDesktop, which the
// web app looks for to know it's in the desktop app (and can have web tabs).

import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopTunnelMsg, DesktopUpdateState, DesktopWebEvent } from "@everywhere/protocol";

const bridge: DesktopBridge = {
  version: process.argv.find((a) => a.startsWith("--everywhere-version="))?.split("=")[1] ?? "",
  platform: process.platform,
  partition: "persist:web",
  onWebEvent(fn) {
    const listener = (_e: Electron.IpcRendererEvent, ev: DesktopWebEvent) => fn(ev);
    ipcRenderer.on("ew:web-event", listener);
    return () => void ipcRenderer.off("ew:web-event", listener);
  },
  onTunnel(fn) {
    const listener = (_e: Electron.IpcRendererEvent, m: DesktopTunnelMsg) => fn(m);
    ipcRenderer.on("ew:tunnel", listener);
    return () => void ipcRenderer.off("ew:tunnel", listener);
  },
  tunnel: {
    opened: (id) => ipcRenderer.send("ew:tunnel-opened", id),
    data: (id, data) => ipcRenderer.send("ew:tunnel-data", id, data),
    closed: (id, error) => ipcRenderer.send("ew:tunnel-closed", id, error),
    pause: (id, paused) => ipcRenderer.send("ew:tunnel-pause", id, paused),
  },
  openExternal(url) {
    ipcRenderer.send("ew:open-external", url);
  },
  favicon(url) {
    return ipcRenderer.invoke("ew:favicon", url) as Promise<string | null>;
  },
  update: {
    state: () => ipcRenderer.invoke("ew:update-state") as Promise<DesktopUpdateState>,
    onChange(fn) {
      const listener = (_e: Electron.IpcRendererEvent, s: DesktopUpdateState) => fn(s);
      ipcRenderer.on("ew:update", listener);
      return () => void ipcRenderer.off("ew:update", listener);
    },
    check: () => ipcRenderer.send("ew:update-check"),
    install: () => ipcRenderer.send("ew:update-install"),
  },
};

contextBridge.exposeInMainWorld("everywhereDesktop", bridge);
