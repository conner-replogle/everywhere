// Like Claude Code's "while you were away" summary: coming back to a thread
// that's been idle a while asks claude for a short recap (/recap), shown as a
// card. The CLI only streams its own recap to Anthropic-hosted sessions.

import type { AgentCommand, AgentState } from "@everywhere/protocol";
import { useEffect, useRef, useState } from "react";
import type { LoggedEvent } from "@/lib/agent";
import { RECAP_PROMPT } from "./timeline";

/** The CLI's threshold for its away summary. */
const AWAY_MS = 5 * 60 * 1000;
const DONE_KEY = "everywhere.recapFor.";

/** Counts the times the page came back into view. */
function useReturns(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const onShow = () => document.visibilityState === "visible" && setN((x) => x + 1);
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, []);
  return n;
}

/**
 * Sends /recap once per stretch of idleness: when the thread is opened, or
 * the page shown again, 5+ minutes after its last turn ended.
 */
export function useAutoRecap({
  threadId,
  enabled,
  ready,
  state,
  events,
  commands,
  send,
}: {
  threadId: string;
  enabled: boolean;
  /** Attached, synced and not archived. */
  ready: boolean;
  state: AgentState | null;
  events: LoggedEvent[];
  commands: AgentCommand[];
  send: () => void;
}) {
  const returns = useReturns();
  const sendRef = useRef(send);
  sendRef.current = send;
  // The last finished turn, and whether it was a recap already.
  let lastAt = 0;
  let lastWasRecap = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!.event;
    if (!lastAt && e.type === "turn" && e.status !== "started") lastAt = events[i]!.at;
    if (e.type === "user" && !e.parentId) {
      lastWasRecap = e.text.trim() === RECAP_PROMPT;
      if (lastAt) break;
    }
  }
  const idle = state?.status === "idle" || state?.status === "stopped";
  const eligible =
    enabled &&
    ready &&
    idle &&
    !state?.pending.length &&
    !lastWasRecap &&
    lastAt > 0 &&
    commands.some((c) => c.name === "recap");

  useEffect(() => {
    if (!eligible || Date.now() - lastAt < AWAY_MS || document.visibilityState !== "visible") return;
    // Once per idle stretch, across reloads and tabs.
    try {
      if (localStorage.getItem(DONE_KEY + threadId) === String(lastAt)) return;
      localStorage.setItem(DONE_KEY + threadId, String(lastAt));
    } catch {
      // storage blocked: this page still only asks once (lastWasRecap after)
    }
    sendRef.current();
  }, [eligible, lastAt, threadId, returns]);
}
