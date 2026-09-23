// Device registry (from the Worker), shared across pages.

import { useEffect, useSyncExternalStore } from "react";
import { api, type Device } from "./api";
import { hub } from "./hub";
import { errorMessage } from "./utils";

interface DevicesSnapshot {
  devices: Device[] | undefined;
  error: string | null;
}

let snap: DevicesSnapshot = { devices: undefined, error: null };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: DevicesSnapshot): void {
  snap = next;
  for (const fn of listeners) fn();
}

export const devices = {
  refresh(): Promise<void> {
    inflight ??= api
      .devices()
      .then((list) => set({ devices: list, error: null }))
      .catch((e: unknown) => set({ ...snap, error: errorMessage(e) }))
      .finally(() => {
        inflight = null;
      });
    return inflight;
  },
  get(id: string): Device | undefined {
    return snap.devices?.find((d) => d.id === id);
  },
  /** Optimistic local edit after a successful PATCH/DELETE. */
  patch(id: string, change: Partial<Device> | null): void {
    if (!snap.devices) return;
    set({
      ...snap,
      devices:
        change === null
          ? snap.devices.filter((d) => d.id !== id)
          : snap.devices.map((d) => (d.id === id ? { ...d, ...change } : d)),
    });
  },
  reset(): void {
    set({ devices: undefined, error: null });
  },
};

// A presence change for a device we don't know yet means one was just
// enrolled; any presence change also moves last-seen times, so refetch.
let lastOnline: ReadonlySet<string> | null = null;
hub.subscribe(() => {
  const { online, presenceKnown } = hub.getSnapshot();
  if (!presenceKnown || online === lastOnline) return;
  const first = lastOnline === null;
  lastOnline = online;
  if (!first && listeners.size > 0) void devices.refresh();
});

export function useDevices(): DevicesSnapshot {
  const s = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => snap,
  );
  useEffect(() => {
    void devices.refresh();
  }, []);
  return s;
}
