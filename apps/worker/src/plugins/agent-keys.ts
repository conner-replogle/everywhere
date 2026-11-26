// What's left of the account's API keys for other agents (Antigravity's
// Gemini key), which version 0.34.0 kept and sent to daemons: they're no
// longer used, Antigravity being signed in with Google on each device. A
// daemon of that version, as it connects, is told to forget any it holds,
// and the hub forgets those it kept.

import type { WorkerPlugin } from "./types";

export const agentKeys: WorkerPlugin = {
  id: "agentKeys",
  hubFeatures: ["agentKeys"],
  onDaemonHello: async (hub, deviceId) => {
    await hub.storage.delete("keys");
    const r = await hub.deviceRpc(deviceId, "agent.setKeys", { keys: {} }, 15_000);
    if (!r.ok) console.warn(`telling ${deviceId} to forget its agent keys: ${r.message}`);
  },
};
