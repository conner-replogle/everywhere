// The threads opened recently in this browser, across every device, shown as
// tabs along the top of the thread page. Kept in this browser only.

import type { ThreadKind } from "@everywhere/protocol";
import { useSyncExternalStore } from "react";

export interface RecentThread {
  deviceId: string;
  threadId: string;
  /** Last seen name and kind, for drawing the tab while its device is offline. */
  name: string;
  kind: ThreadKind;
  visitedAt: number;
}

/** Past this many, the least recently visited tab is dropped. */
const MAX_RECENT = 8;
const STORAGE_KEY = "everywhere.recentThreads";

let recent: readonly RecentThread[] = read();
const listeners = new Set<() => void>();

function read(): RecentThread[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(v) ? (v as RecentThread[]) : [];
  } catch {
    return [];
  }
}

function set(next: readonly RecentThread[]): void {
  recent = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the tabs last until reload
  }
  for (const fn of listeners) fn();
}

const same = (r: RecentThread, deviceId: string, threadId: string) =>
  r.deviceId === deviceId && r.threadId === threadId;

/** Adds a thread as a tab, or refreshes its tab in place so tabs don't shuffle. */
export function visitThread(deviceId: string, threadId: string, t: { name: string; kind: ThreadKind }): void {
  const entry: RecentThread = { deviceId, threadId, name: t.name, kind: t.kind, visitedAt: Date.now() };
  let next = recent.some((r) => same(r, deviceId, threadId))
    ? recent.map((r) => (same(r, deviceId, threadId) ? entry : r))
    : [...recent, entry];
  while (next.length > MAX_RECENT) {
    const oldest = next.reduce((a, b) => (b.visitedAt < a.visitedAt ? b : a));
    next = next.filter((r) => r !== oldest);
  }
  set(next);
}

export function forgetThread(deviceId: string, threadId: string): void {
  if (recent.some((r) => same(r, deviceId, threadId))) set(recent.filter((r) => !same(r, deviceId, threadId)));
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Other windows of this browser share the tabs.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    recent = read();
    for (const fn of listeners) fn();
  });
}

export function useRecentThreads(): readonly RecentThread[] {
  return useSyncExternalStore(subscribe, () => recent);
}
