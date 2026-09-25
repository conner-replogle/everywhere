// In-app alerts: a claude thread finished or needs the user (relayed by the
// hub from the daemon's notify), shown as toasts with a way to switch to it.

import type { HubAlert } from "@everywhere/protocol";
import { useSyncExternalStore } from "react";

export interface Alert extends HubAlert {
  id: string;
}

/** Older alerts past this many are dropped. */
const MAX_ALERTS = 4;
/** Set to "0" when alerts are turned off in this browser; on by default. */
const ENABLED_KEY = "everywhere.inAppAlerts";

let alerts: readonly Alert[] = [];
const listeners = new Set<() => void>();
let nextId = 0;
let enabled = readEnabled();

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Whether this browser shows alerts in the app. */
export function alertsEnabled(): boolean {
  return enabled;
}

export function setAlertsEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(ENABLED_KEY);
    else localStorage.setItem(ENABLED_KEY, "0");
  } catch {
    // storage blocked: the choice lasts until reload
  }
  enabled = on;
  set(on ? alerts : []);
}

/** The thread an alert is about: the tab's thread, or the thread itself. */
export function alertThread(a: HubAlert): string {
  return a.parentId || a.threadId;
}

function set(next: readonly Alert[]): void {
  alerts = next;
  for (const fn of listeners) fn();
}

/** Shows an alert, replacing any earlier one about the same thread or tab. */
export function pushAlert(a: HubAlert): void {
  if (!enabled) return;
  const rest = alerts.filter((x) => !(x.deviceId === a.deviceId && x.threadId === a.threadId));
  set([...rest, { ...a, id: String(nextId++) }].slice(-MAX_ALERTS));
}

export function dismissAlert(id: string): void {
  if (alerts.some((a) => a.id === id)) set(alerts.filter((a) => a.id !== id));
}

/** Drops the alerts about a thread (and its tabs), e.g. once it's opened. */
export function dismissThreadAlerts(deviceId: string, threadId: string): void {
  const match = (a: Alert) => a.deviceId === deviceId && alertThread(a) === threadId;
  if (alerts.some(match)) set(alerts.filter((a) => !match(a)));
}

/** Calls fn whenever the alerts or whether they're on change. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAlerts(): readonly Alert[] {
  return useSyncExternalStore(subscribe, () => alerts);
}

export function useAlertsEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => enabled);
}
