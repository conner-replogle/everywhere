// Reading a claude thread without showing it: open its agent channel,
// replay the newest events, optionally send something, and close it.

import type { AgentDaemonMsg, AgentEvent, AgentState } from "@everywhere/protocol";
import type { DevicePeer } from "./peer";

const READ_TIMEOUT_MS = 15_000;
/** After the replay, how long to wait for the thread's state. */
const STATE_WAIT_MS = 1000;

/** Opens a thread's agent channel, replays its newest events, and closes it. */
export function readAgent(
  peer: DevicePeer,
  threadId: string,
  limit: number,
  then?: (send: (msg: object) => void) => Promise<void>,
): Promise<{ events: AgentEvent[]; state: AgentState | null; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const events: AgentEvent[] = [];
    let state: AgentState | null = null;
    let truncated = false;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(stateTimer);
      ch.close();
      if (err) reject(err);
      else resolve({ events, state, truncated });
    };
    const timer = setTimeout(() => finish(new Error("the device didn't answer in time")), READ_TIMEOUT_MS);
    let stateTimer: ReturnType<typeof setTimeout> | undefined;
    let ran = false;
    const replayed = () => {
      clearTimeout(stateTimer);
      if (ran) return;
      ran = true;
      if (!then) return finish();
      then((msg) => ch.send(msg as never)).then(
        () => finish(),
        (e: unknown) => finish(e instanceof Error ? e : new Error(String(e))),
      );
    };
    const ch = peer.openAgent(threadId, {
      onOpen: () => ch.send({ t: "attach", limit }),
      onMessage: (m: AgentDaemonMsg) => {
        if (m.t === "event") events.push(m.event);
        else if (m.t === "error") finish(new Error(m.message));
        else if (m.t === "synced") {
          truncated = m.truncated;
          // The thread's state comes right after; older daemons may not send it.
          stateTimer = setTimeout(replayed, STATE_WAIT_MS);
        } else if (m.t === "state") {
          state = m.state;
          if (stateTimer) replayed();
        }
      },
      onClose: () => finish(done ? undefined : new Error("the thread's channel closed")),
    });
  });
}
