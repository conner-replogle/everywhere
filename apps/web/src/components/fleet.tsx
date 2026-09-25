// Every enrolled device at once: a connection to each one that's online and
// its projects and threads, for the workspace that shows them all together.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { DeviceContextValue } from "@/components/device-context";
import type { Device } from "@/lib/api";
import { useDevices } from "@/lib/devices";
import { usePeer, useRpc } from "@/lib/peer";

export interface Fleet {
  /** The registry; undefined while loading. */
  devices: Device[] | undefined;
  error: string | null;
  /** Per device id, once its source has reported. */
  entries: ReadonlyMap<string, DeviceContextValue>;
}

const FleetContext = createContext<Fleet | null>(null);

export function useFleet(): Fleet {
  const ctx = useContext(FleetContext);
  if (!ctx) throw new Error("useFleet must be used under FleetProvider");
  return ctx;
}

export function FleetProvider({ children }: { children: React.ReactNode }) {
  const { devices, error } = useDevices();
  const [reported, setReported] = useState<Record<string, DeviceContextValue>>({});
  const report = useCallback((e: DeviceContextValue) => setReported((r) => ({ ...r, [e.deviceId]: e })), []);

  const value = useMemo<Fleet>(() => {
    // Removed devices drop out with the registry.
    const entries = new Map<string, DeviceContextValue>();
    for (const d of devices ?? []) {
      const e = reported[d.id];
      if (e) entries.set(d.id, e);
    }
    return { devices, error, entries };
  }, [devices, error, reported]);

  return (
    <FleetContext.Provider value={value}>
      {devices?.map((d) => (
        <DeviceSource key={d.id} device={d} onReport={report} />
      ))}
      {children}
    </FleetContext.Provider>
  );
}

/** Holds one device's connection open and reports its state and data. */
function DeviceSource({ device, onReport }: { device: Device; onReport: (e: DeviceContextValue) => void }) {
  const { peer, ...conn } = usePeer(device.id);
  const info = useRpc(peer, "device.info", {});
  const projects = useRpc(peer, "projects.list", {}, ["projects.changed"]);
  const threads = useRpc(peer, "threads.list", {}, ["threads.changed"]);
  const clones = useRpc(peer, "clones.list", {}, ["clones.changed"], !!info.data?.features?.includes("clone"));

  // Keyed on the data, not the query objects, which are new every render.
  useEffect(() => {
    onReport({ deviceId: device.id, device, peer, conn, info, projects, threads, clones });
  }, [
    onReport,
    device,
    peer,
    conn.state,
    conn.error,
    conn.generation,
    info.data,
    info.error,
    projects.data,
    projects.error,
    threads.data,
    threads.error,
    clones.data,
  ]);
  return null;
}
