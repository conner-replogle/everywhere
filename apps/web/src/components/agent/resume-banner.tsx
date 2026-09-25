import type { AgentContext } from "@everywhere/protocol";
import { Minimize2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatTokens } from "./composer-parts";

// Like t3code: a conversation left alone past the prompt cache's lifetime
// (an hour) costs its whole context again on the next message, so a big one
// is worth compacting first.
const STALE_MS = 70 * 60 * 1000;
const STALE_TOKENS = 100_000;
const DISMISS_KEY = "everywhere.keepHistory.";

function dismissedAt(threadId: string): number {
  try {
    return Number(localStorage.getItem(DISMISS_KEY + threadId) ?? 0);
  } catch {
    return 0;
  }
}

/** The current time, updated each minute. */
function useNowMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Offers compacting a big conversation that's been idle long enough for its cache to expire. */
export function ResumeBanner({
  threadId,
  context,
  canCompact,
  onCompact,
}: {
  threadId: string;
  context: AgentContext | undefined;
  /** Idle, with /compact available. */
  canCompact: boolean;
  onCompact: () => void;
}) {
  const now = useNowMinute();
  // Dismissing is per measurement: using the thread again and leaving it re-arms it.
  const [dismissed, setDismissed] = useState(() => dismissedAt(threadId));
  useEffect(() => setDismissed(dismissedAt(threadId)), [threadId]);

  const at = context?.updatedAt;
  if (!canCompact || !context || !at || context.used < STALE_TOKENS || now - at < STALE_MS || dismissed >= at) {
    return null;
  }
  const keep = () => {
    try {
      localStorage.setItem(DISMISS_KEY + threadId, String(at));
    } catch {
      // storage blocked: dismissed until reload
    }
    setDismissed(at);
  };
  const idle = Math.round((now - at) / 3_600_000);
  return (
    <div className="flex items-center gap-3 rounded-md border bg-card px-3 py-2 text-[13px] max-sm:flex-wrap">
      <Minimize2Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="grid min-w-0 flex-1">
        <span className="font-medium">Resume with less context</span>
        <span className="text-xs text-muted-foreground">
          {formatTokens(context.used)} tokens from {idle >= 1 ? `${idle}h ago` : "over an hour ago"}; the next message
          reads all of them again. Compacting summarizes them first.
        </span>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <Button size="sm" variant="ghost" onClick={keep}>
          Keep full history
        </Button>
        <Button size="sm" variant="secondary" onClick={onCompact}>
          <Minimize2Icon />
          Compact
        </Button>
      </div>
    </div>
  );
}
