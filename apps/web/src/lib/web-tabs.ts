// Web tabs: pages opened from links (a process's web UI, a link in Claude's
// reply) as tabs of a thread, shown in an iframe in this browser. They live
// in this browser only, not on the device: the page loads from where you
// are, not from the device.

import { useSyncExternalStore } from "react";

export interface WebTab {
  id: string;
  url: string;
  /** What the tab is called: the page's host, until renamed. */
  name: string;
}

const PREFIX = "ew:web-tabs:";
const EMPTY: readonly WebTab[] = [];

const key = (deviceId: string, threadId: string) => `${PREFIX}${deviceId}/${threadId}`;
const cache = new Map<string, readonly WebTab[]>();
const listeners = new Set<() => void>();

function read(k: string): readonly WebTab[] {
  const hit = cache.get(k);
  if (hit) return hit;
  let tabs: readonly WebTab[] = EMPTY;
  try {
    const v: unknown = JSON.parse(localStorage.getItem(k) ?? "[]");
    if (Array.isArray(v)) {
      tabs = v.filter(
        (t): t is WebTab => !!t && typeof t.id === "string" && typeof t.url === "string" && typeof t.name === "string",
      );
    }
  } catch {
    // storage blocked or garbled: no tabs
  }
  cache.set(k, tabs);
  return tabs;
}

function write(k: string, tabs: readonly WebTab[]) {
  cache.set(k, tabs);
  try {
    if (tabs.length) localStorage.setItem(k, JSON.stringify(tabs));
    else localStorage.removeItem(k);
  } catch {
    // storage blocked: the tabs last until reload
  }
  for (const fn of listeners) fn();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (!e.key?.startsWith(PREFIX)) return;
    cache.delete(e.key);
    for (const fn of listeners) fn();
  });
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A thread's web tabs, in the order they were opened. */
export function useWebTabs(deviceId: string, threadId: string): readonly WebTab[] {
  const k = key(deviceId, threadId);
  return useSyncExternalStore(subscribe, () => read(k));
}

/** Opens url as a web tab of the thread, or finds the tab already showing it. */
export function openWebTab(deviceId: string, threadId: string, url: string): WebTab {
  const k = key(deviceId, threadId);
  const tabs = read(k);
  const same = tabs.find((t) => t.url === url);
  if (same) return same;
  let name = url;
  try {
    name = new URL(url).host || url;
  } catch {
    // not a URL we can name: use it as is
  }
  const tab = { id: `web-${crypto.randomUUID().slice(0, 8)}`, url, name };
  write(k, [...tabs, tab]);
  return tab;
}

export function closeWebTab(deviceId: string, threadId: string, id: string): void {
  const k = key(deviceId, threadId);
  write(
    k,
    read(k).filter((t) => t.id !== id),
  );
}

export function renameWebTab(deviceId: string, threadId: string, id: string, name: string): void {
  const k = key(deviceId, threadId);
  write(
    k,
    read(k).map((t) => (t.id === id ? { ...t, name: name.trim() || t.name } : t)),
  );
}

/**
 * Why the page can't show in a tab here, or null if it can: an http page
 * inside this https app is blocked by the browser (mixed content), except
 * on this machine's own loopback.
 */
export function framingBlocked(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "That isn't a web address.";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "Only web pages open in a tab.";
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol === "http:" && location.protocol === "https:" && !loopback) {
    return "Browsers don't show http pages inside an https app. Serve it over https (for a dev server on Tailscale, tailscale serve gives it an https address), or open it in a new tab.";
  }
  return null;
}
