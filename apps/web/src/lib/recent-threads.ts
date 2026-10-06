// The threads opened recently in this browser, across every device, shown as
// tabs along the top of the thread page. Kept in this browser only.
//
// Like VS Code's preview editor, a thread opened by just selecting it gets a
// single reusable preview tab: opening another thread replaces it in place
// instead of adding a tab. The preview becomes a kept tab once the user
// interacts with the thread (a prompt sent, keys typed into a terminal),
// keeps it explicitly (double-click or the pin), or looks at it for
// PREVIEW_DWELL_MS while the page is in the foreground.

import type { ThreadKind } from "@everywhere/protocol";
import { useSyncExternalStore } from "react";

export interface RecentThread {
  deviceId: string;
  threadId: string;
  /** Last seen name and kind, for drawing the tab while its device is offline. */
  name: string;
  kind: ThreadKind;
  visitedAt: number;
  /** The reusable preview tab; at most one. Absent (older entries too) means kept. */
  preview?: boolean;
}

/**
 * How long a preview tab is looked at, with the page in the foreground,
 * before it's kept. Long enough that clicking through threads to check on
 * them doesn't keep them all; short enough that reading one does.
 */
export const PREVIEW_DWELL_MS = 20_000;

/** Past this many, the least recently visited tab is dropped (the preview first). */
export const MAX_RECENT = 12;
const STORAGE_KEY = "everywhere.recentThreads";

let recent: readonly RecentThread[] = read();
const listeners = new Set<() => void>();

function read(): RecentThread[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(v) ? normalize(v as RecentThread[]) : [];
  } catch {
    return [];
  }
}

function set(next: readonly RecentThread[]): void {
  if (next === recent) return;
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

/** At most one preview: the most recently visited one keeps the role. */
export function normalize(list: RecentThread[]): RecentThread[] {
  const previews = list.filter((r) => r.preview);
  if (previews.length <= 1) return list;
  const keep = previews.reduce((a, b) => (b.visitedAt > a.visitedAt ? b : a));
  return list.map((r) => (r.preview && r !== keep ? { ...r, preview: false } : r));
}

/**
 * Opening a thread. A thread that already has a tab keeps it, in place, so
 * tabs don't shuffle (and a kept tab stays kept). Otherwise it takes over
 * the preview tab, or gets a new preview tab; retain makes it a kept tab.
 */
export function withVisit(
  list: readonly RecentThread[],
  deviceId: string,
  threadId: string,
  t: { name: string; kind: ThreadKind },
  opts: { retain?: boolean; now?: number; max?: number } = {},
): RecentThread[] {
  const now = opts.now ?? Date.now();
  const max = opts.max ?? MAX_RECENT;
  const existing = list.find((r) => same(r, deviceId, threadId));
  const entry: RecentThread = {
    deviceId,
    threadId,
    name: t.name,
    kind: t.kind,
    visitedAt: now,
    preview: opts.retain ? false : existing ? existing.preview : true,
  };
  let next: RecentThread[];
  if (existing) next = list.map((r) => (r === existing ? entry : r));
  else {
    const preview = entry.preview ? list.findIndex((r) => r.preview) : -1;
    next = preview >= 0 ? list.map((r, i) => (i === preview ? entry : r)) : [...list, entry];
  }
  while (next.length > max) {
    const others = next.filter((r) => r !== entry);
    const oldest = others.find((r) => r.preview) ?? others.reduce((a, b) => (b.visitedAt < a.visitedAt ? b : a));
    next = next.filter((r) => r !== oldest);
  }
  return normalize(next);
}

/** Turns the thread's preview tab into a kept one; adds it as kept if it has no tab and t is given. */
export function withRetain(
  list: readonly RecentThread[],
  deviceId: string,
  threadId: string,
  t?: { name: string; kind: ThreadKind },
): readonly RecentThread[] {
  const existing = list.find((r) => same(r, deviceId, threadId));
  if (existing) return existing.preview ? list.map((r) => (r === existing ? { ...r, preview: false } : r)) : list;
  return t ? withVisit(list, deviceId, threadId, t, { retain: true }) : list;
}

/** Gives a thread a tab, or refreshes its tab. See withVisit. */
export function visitThread(
  deviceId: string,
  threadId: string,
  t: { name: string; kind: ThreadKind },
  opts: { retain?: boolean } = {},
): void {
  set(withVisit(recent, deviceId, threadId, t, opts));
}

/** Keeps the thread's tab, so opening another thread doesn't replace it. See withRetain. */
export function retainThread(deviceId: string, threadId: string, t?: { name: string; kind: ThreadKind }): void {
  set(withRetain(recent, deviceId, threadId, t));
}

export function forgetThread(deviceId: string, threadId: string): void {
  if (recent.some((r) => same(r, deviceId, threadId))) set(recent.filter((r) => !same(r, deviceId, threadId)));
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn", "OS"]);

/**
 * Whether a key pressed in a terminal, browser or desktop pane is input to
 * it, which keeps the thread's preview tab. Bare modifiers, the OS's own
 * shortcuts (Meta) and copying (Ctrl+Shift+C) aren't.
 */
export function isInputKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey">): boolean {
  if (MODIFIER_KEYS.has(e.key) || e.metaKey) return false;
  return !(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c");
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
