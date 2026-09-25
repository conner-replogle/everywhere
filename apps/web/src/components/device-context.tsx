import type { CloneStatus, DeviceInfo, Project, Thread } from "@everywhere/protocol";
import { createContext, useContext } from "react";
import type { Device } from "@/lib/api";
import type { DevicePeer, PeerSnapshot, RpcQuery } from "@/lib/peer";

/** One device's connection and live data; the fleet keeps one per enrolled device. */
export interface DeviceContextValue {
  deviceId: string;
  /** Registry entry from the Worker. */
  device: Device;
  peer: DevicePeer;
  conn: PeerSnapshot;
  info: RpcQuery<DeviceInfo>;
  projects: RpcQuery<Project[]>;
  threads: RpcQuery<Thread[]>;
  /** Clones into new projects; empty data when the daemon can't clone. */
  clones: RpcQuery<CloneStatus[]>;
}

export const DeviceContext = createContext<DeviceContextValue | null>(null);

export function useDevice(): DeviceContextValue {
  const ctx = useContext(DeviceContext);
  if (!ctx) throw new Error("useDevice must be used under a DeviceContext");
  return ctx;
}
