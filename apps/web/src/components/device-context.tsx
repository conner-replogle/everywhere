import type { DeviceInfo, Project, Thread } from "@everywhere/protocol";
import { createContext, useContext } from "react";
import type { Device } from "@/lib/api";
import type { DevicePeer, PeerSnapshot, RpcQuery } from "@/lib/peer";

export interface DeviceContextValue {
  deviceId: string;
  /** Registry entry from the Worker; undefined while loading. */
  device: Device | undefined;
  peer: DevicePeer;
  conn: PeerSnapshot;
  info: RpcQuery<DeviceInfo>;
  projects: RpcQuery<Project[]>;
  threads: RpcQuery<Thread[]>;
}

export const DeviceContext = createContext<DeviceContextValue | null>(null);

export function useDevice(): DeviceContextValue {
  const ctx = useContext(DeviceContext);
  if (!ctx) throw new Error("useDevice must be used under /d/$deviceId");
  return ctx;
}
