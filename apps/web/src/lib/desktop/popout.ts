// Remote desktop in a window of its own. A device streams its desktop to one
// viewer at a time, so a view that is popped out steps aside for its window
// until that window closes.

import type { DesktopSource } from "@everywhere/protocol";
import { useSyncExternalStore } from "react";

/** The message a view sends its window when the thread's agent opens something on the desktop. */
export const SHOW_MESSAGE = "ew.desktop.show";

const windows = new Map<string, Window>();
const listeners = new Set<() => void>();
let poll: ReturnType<typeof setInterval> | undefined;

function changed() {
  for (const fn of listeners) fn();
}

// A window's closing has no event its opener can hear: look now and then.
function watch() {
  if (poll) return;
  poll = setInterval(() => {
    let gone = false;
    for (const [key, w] of windows) {
      if (w.closed) {
        windows.delete(key);
        gone = true;
      }
    }
    if (windows.size === 0) {
      clearInterval(poll);
      poll = undefined;
    }
    if (gone) changed();
  }, 400);
}

/** One view of a device's desktop: its Remote desktop page, or one desktop tab. */
export function popoutKey(deviceId: string, tabId?: string): string {
  return `${deviceId}/${tabId ?? "page"}`;
}

/**
 * Opens the view in a window of its own, or brings its window forward if it
 * already has one. False if the browser blocked the window.
 */
export function popOut(deviceId: string, tab?: { id: string; state?: string }): boolean {
  const key = popoutKey(deviceId, tab?.id);
  const open = windows.get(key);
  if (open && !open.closed) {
    open.focus();
    return true;
  }
  const search = new URLSearchParams();
  if (tab) {
    search.set("tab", tab.id);
    if (tab.state) search.set("state", tab.state);
  }
  const qs = search.toString();
  const url = `/popout/d/${encodeURIComponent(deviceId)}/desktop${qs ? `?${qs}` : ""}`;
  const width = Math.round(Math.min(1600, screen.availWidth * 0.8));
  const height = Math.round(Math.min(1000, screen.availHeight * 0.8));
  const w = window.open(url, `ew-desktop-${key}`, `popup,width=${width},height=${height}`);
  if (!w) return false;
  windows.set(key, w);
  watch();
  changed();
  return true;
}

/** Closes the view's window, putting the view back where it was. */
export function bringBack(key: string): void {
  windows.get(key)?.close();
  windows.delete(key);
  changed();
}

/** Brings the view's window to the front. */
export function focusPopout(key: string): void {
  windows.get(key)?.focus();
}

/** Has the view's window show what the agent opened. */
export function showInPopout(key: string, source: DesktopSource): void {
  windows.get(key)?.postMessage({ type: SHOW_MESSAGE, source }, location.origin);
}

/** Whether the view is out in a window of its own. */
export function usePoppedOut(key: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => windows.has(key),
  );
}
