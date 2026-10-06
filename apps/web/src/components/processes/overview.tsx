import type { Process } from "@everywhere/protocol";
import type { DevicePeer } from "@/lib/peer";
import { cn } from "@/lib/utils";
import { failed, formatDuration, formatNumber, isRunning, StatusMark, statusLabel, useNow } from "./progress";
import { useProcesses } from "./use-processes";

/** Finished processes stay in the overview this long. */
const RECENT_MS = 10 * 60_000;
const MAX_ROWS = 3;

/**
 * The thread's processes at a glance, for the claude tab: what's running and
 * what just finished, one line each. A row opens the process in the
 * processes tab.
 */
export function ProcessesOverview({
  peer,
  threadId,
  onOpen,
}: {
  peer: DevicePeer;
  /** The thread whose processes these are. */
  threadId: string;
  /** Opens the processes tab, on this process if given. */
  onOpen: (processId?: string) => void;
}) {
  const list = useProcesses(peer, threadId);
  const all = list.data ?? [];
  const now = useNow(all.some(isRunning));
  const shown = all
    .filter((p) => isRunning(p) || (p.endedAt !== undefined && now - p.endedAt < RECENT_MS))
    .sort((a, b) => Number(isRunning(b)) - Number(isRunning(a)) || b.startedAt - a.startedAt);
  if (shown.length === 0) return null;
  const more = shown.length - MAX_ROWS;
  return (
    <div className="grid overflow-hidden rounded-md border text-xs" aria-label="Processes">
      {shown.slice(0, MAX_ROWS).map((p) => (
        <OverviewRow key={p.id} process={p} now={now} onOpen={() => onOpen(p.id)} />
      ))}
      {more > 0 && (
        <button
          type="button"
          onClick={() => onOpen()}
          className="border-t px-2.5 py-1 text-left text-muted-foreground hover:bg-accent/40 hover:text-foreground"
        >
          {more} more…
        </button>
      )}
    </div>
  );
}

function OverviewRow({ process: p, now, onOpen }: { process: Process; now: number; onOpen: () => void }) {
  const running = isRunning(p);
  const progress = summarize(p, running);
  const label = statusLabel(p);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={p.command ?? "Tracker"}
      className="flex items-center gap-2 px-2.5 py-1.5 text-left not-first:border-t hover:bg-accent/40"
    >
      <StatusMark process={p} />
      <span className="max-w-[30%] shrink-0 truncate font-medium">{p.name}</span>
      {progress?.fraction !== undefined && (
        <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
          <span
            className={cn("block h-full rounded-full", failed(p) ? "bg-destructive" : running ? "bg-primary" : "bg-live")}
            style={{ width: `${Math.min(100, progress.fraction * 100)}%` }}
          />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{progress?.text}</span>
      {label && <span className={cn("shrink-0", failed(p) ? "text-destructive" : "text-muted-foreground")}>{label}</span>}
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {formatDuration(((p.endedAt ?? now) - p.startedAt) / 1000)}
      </span>
    </button>
  );
}

/**
 * The one line of progress worth showing: the first counter, else the
 * checkpoints, else terminal progress, with the status text or last line.
 */
function summarize(p: Process, running: boolean): { fraction?: number; text?: string } | undefined {
  const words = p.statusText || (running ? p.lastLine : undefined);
  const counter = p.stats.find((s) => s.total !== undefined && s.total > 0);
  if (counter) {
    const eta = running && counter.eta !== undefined ? ` · ~${formatDuration(counter.eta)}` : "";
    return {
      fraction: counter.value / counter.total!,
      text: [`${formatNumber(counter.value)}/${formatNumber(counter.total!)}${eta}`, words].filter(Boolean).join(" · "),
    };
  }
  if (p.checkpoints.length > 0) {
    const reached = p.checkpoints.filter((c) => c.reachedAt);
    const last = reached[reached.length - 1];
    return {
      fraction: reached.length / p.checkpoints.length,
      text: [last?.label, words].filter(Boolean).join(" · "),
    };
  }
  if (running && p.progress && p.progress.state !== "indeterminate") {
    return { fraction: p.progress.percent / 100, text: words };
  }
  return { text: words };
}
