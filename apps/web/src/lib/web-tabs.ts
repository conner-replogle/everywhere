// Web tabs: pages opened from links (a process's web UI, a link in Claude's
// reply) as tabs of a thread. They live in this app only, not on the device:
// the page loads from where you are, in the desktop app (lib/desktop.ts),
// since a browser can't show most sites inside another page.

import { useSyncExternalStore } from "react";

export interface WebTab {
  id: string;
  /** The page it shows: where it last navigated. */
  url: string;
  /** What the tab is called: the page's title, or what it was renamed to. */
  name: string;
  /** Renamed: the page's title no longer names it. */
  renamed?: boolean;
  /** The page's icon, a data: URL. */
  icon?: string;
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

/**
 * Opens url as a web tab of the thread, or (unless fresh: a page asked for a
 * new tab) finds the tab already showing it.
 */
export function openWebTab(deviceId: string, threadId: string, url: string, opts: { fresh?: boolean } = {}): WebTab {
  const k = key(deviceId, threadId);
  const tabs = read(k);
  const same = !opts.fresh && tabs.find((t) => t.url === url);
  if (same) return same;
  let name = url === "about:blank" ? "New tab" : url;
  try {
    name = new URL(url).host || name;
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
    read(k).map((t) => (t.id === id ? { ...t, name: name.trim() || t.name, renamed: !!name.trim() || t.renamed } : t)),
  );
}

/** Keeps what a tab's page is now: where it went, its title (unless renamed) and icon. */
export function updateWebTab(
  deviceId: string,
  threadId: string,
  id: string,
  page: { url?: string; title?: string; icon?: string | null },
): void {
  const k = key(deviceId, threadId);
  const tabs = read(k);
  const t = tabs.find((t) => t.id === id);
  if (!t) return;
  const next: WebTab = { ...t };
  if (page.url) next.url = page.url;
  if (page.title?.trim() && !t.renamed) next.name = page.title.trim();
  if (page.icon !== undefined) next.icon = page.icon ?? undefined;
  if (next.url === t.url && next.name === t.name && next.icon === t.icon) return;
  write(
    k,
    tabs.map((x) => (x.id === id ? next : x)),
  );
}

/** What was typed in an address bar, as a URL: an address (https unless it's this machine), or a search. */
export function addressToUrl(typed: string): string {
  const s = typed.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|view-source):/i.test(s)) return s;
  const hostish = /^(localhost|[\w-]+(\.[\w-]+)+|\[[\da-f:]+\])(:\d+)?(\/.*)?$/i.test(s) && !/\s/.test(s);
  if (hostish) {
    const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)/i.test(s);
    return `${local ? "http" : "https"}://${s}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}
