import { useEffect } from "react";
import { type DevicePeer, useRpc } from "@/lib/peer";

/** A thread's processes, refetched when they change. */
export function useProcesses(peer: DevicePeer, threadId: string, enabled = true) {
  const list = useRpc(peer, "processes.list", { threadId }, [], enabled);
  const { refetch } = list;
  useEffect(() => {
    if (!enabled) return;
    return peer.onEvent((e) => {
      if (e.event === "processes.changed" && e.threadId === threadId) refetch();
    });
  }, [peer, threadId, refetch, enabled]);
  return list;
}
