// Project favicons, found by the daemon in each project's files (see
// daemon/internal/favicon). Fetched once per page load and kept in this
// browser, so the sidebar draws them at once next time.

import { useEffect, useState } from "react";
import type { DevicePeer } from "@/lib/peer";

const PREFIX = "everywhere.projectIcon.";
/** data: URL per project, or null for none; absent until known. */
const icons = new Map<string, string | null>();
const fetched = new Set<string>();
const listeners = new Set<() => void>();

function read(key: string): string | null | undefined {
  if (icons.has(key)) return icons.get(key);
  try {
    const v = localStorage.getItem(PREFIX + key);
    if (v !== null) icons.set(key, v || null);
    return v === null ? undefined : v || null;
  } catch {
    return undefined;
  }
}

function store(key: string, url: string | null): void {
  if (icons.get(key) === url) return;
  icons.set(key, url);
  try {
    localStorage.setItem(PREFIX + key, url ?? "");
  } catch {
    // storage full or blocked: the icon lasts until reload
  }
  for (const fn of listeners) fn();
}

/** The project's icon as a data: URL; null when it has none or the daemon can't say. */
export function useProjectIcon(peer: DevicePeer, deviceId: string, projectId: string, enabled: boolean): string | null {
  const key = `${deviceId}.${projectId}`;
  const [, rerender] = useState(0);
  useEffect(() => {
    const fn = () => rerender((n) => n + 1);
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }, []);
  useEffect(() => {
    if (!enabled || fetched.has(key)) return;
    fetched.add(key);
    peer.call("projects.icon", { id: projectId }).then(
      ({ icon }) => store(key, icon ? `data:${icon.mime};base64,${icon.data}` : null),
      () => fetched.delete(key), // try again next render, e.g. after a reconnect
    );
  }, [peer, key, projectId, enabled]);
  return read(key) ?? null;
}
