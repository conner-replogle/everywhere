import type { Thread } from "@everywhere/protocol";
import { Link } from "@tanstack/react-router";
import { SparklesIcon, SquareTerminalIcon } from "lucide-react";
import { ThreadStatusDot } from "@/components/app-sidebar";
import { threadRecency } from "@/components/scratch";
import { timeAgo } from "@/lib/utils";

/** A thread as a device's page lists it: its kind, name, status and when it was last used. */
export function ThreadLine({ deviceId, thread: t, detail }: { deviceId: string; thread: Thread; detail?: string }) {
  const Icon = t.kind === "claude" ? SparklesIcon : SquareTerminalIcon;
  return (
    <li>
      <Link
        to="/d/$deviceId/t/$threadId"
        params={{ deviceId, threadId: t.id }}
        className="flex h-9 items-center gap-2 rounded-md px-2 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{t.name}</span>
        <ThreadStatusDot thread={t} deviceId={deviceId} />
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
          {detail && <span>{detail}</span>}
          <span>{timeAgo(threadRecency(t))}</span>
        </span>
      </Link>
    </li>
  );
}
