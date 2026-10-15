// Threads nobody has touched in a while drop out of the sidebar's default
// view. Only what the sidebar shows changes: the thread, its history and
// anything running in it are left alone, and it comes back the moment it's
// touched again (or from the sidebar's "idle" row).

import type { Thread } from "@everywhere/protocol";
import { useSyncExternalStore } from "react";

/** How long a thread goes untouched before the sidebar hides it. */
export const IDLE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
/** Scratch threads are quick one-offs, so they go idle sooner. */
export const SCRATCH_IDLE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * When the thread was last touched: a prompt sent or keys typed (the daemon's
 * lastOpenedAt, also bumped by its tabs), opened in this browser, or else
 * created. Undefined when none of those is a usable time.
 */
export function lastTouched(t: Pick<Thread, "lastOpenedAt" | "createdAt">, local?: number): number | undefined {
  const times = [t.lastOpenedAt, t.createdAt, local].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
  return times.length ? Math.max(...times) : undefined;
}

/** Busy threads stay put whatever their age: running, working, waiting on the user, or with processes running. */
export function isBusy(t: Pick<Thread, "running" | "agentStatus" | "processes">): boolean {
  return (
    t.running ||
    t.agentStatus === "working" ||
    t.agentStatus === "starting" ||
    t.agentStatus === "waiting" ||
    (t.processes ?? 0) > 0
  );
}

/** Whether the sidebar hides the thread by default. A thread with no usable time is never hidden. */
export function isIdle(t: Thread, now: number, local?: number, after = IDLE_AFTER_MS): boolean {
  if (t.archivedAt || isBusy(t)) return false;
  const at = lastTouched(t, local);
  return at !== undefined && now - at >= after;
}

/**
 * Whether the thread's agent said its work is done (or the user marked it),
 * so the sidebar puts it away until someone works in it again. Looking at it
 * doesn't bring it back: that's what reading the result is. A process left
 * running (a dev server for the user) doesn't keep it out either.
 */
export function isDone(t: Thread): boolean {
  if (t.archivedAt || !t.doneAt) return false;
  return t.agentStatus !== "working" && t.agentStatus !== "starting" && t.agentStatus !== "waiting";
}

// --- touches in this browser ------------------------------------------------
// Opening a thread here, or asking to keep it listed, counts as touching it.
// The daemon only hears about prompts and keystrokes, so these are kept here.

const STORAGE_KEY = "ew:thread-touches";
/** Touches older than this can't keep a thread listed any more, so they're dropped. */
const KEEP_MS = IDLE_AFTER_MS * 2;

let touches: Readonly<Record<string, number>> = read();
const listeners = new Set<() => void>();

function read(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export const touchKey = (deviceId: string, threadId: string) => `${deviceId}/${threadId}`;

/** Marks a thread touched now in this browser. */
export function touchThread(deviceId: string, threadId: string, now = Date.now()): void {
  const next: Record<string, number> = {};
  for (const [k, at] of Object.entries(touches)) if (now - at < KEEP_MS) next[k] = at;
  next[touchKey(deviceId, threadId)] = now;
  touches = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the touch lasts until reload
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    touches = read();
    for (const fn of listeners) fn();
  });
}

/** This browser's touches, by touchKey. */
export function useThreadTouches(): Readonly<Record<string, number>> {
  return useSyncExternalStore(subscribe, () => touches);
}
