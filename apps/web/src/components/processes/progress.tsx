import type { Process, ProcessCheckpoint, ProcessStat } from "@everywhere/protocol";
import { CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** 8s, 1m08s, 2h05m. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 10 ? 2 : 1 });
}

function formatRate(r: number): string {
  return `${r.toLocaleString(undefined, { maximumSignificantDigits: 3 })}/s`;
}

export const isRunning = (p: Process) => p.status === "running";
export const failed = (p: Process) =>
  p.status === "failed" || p.status === "lost" || (p.status === "exited" && p.exitCode !== 0);

/**
 * How far into the checkpoint after the last reached one the process is, 0-1,
 * or null if there's no telling: from its terminal progress, else from how
 * long the previous run took to get there.
 */
function currentFraction(p: Process, i: number, now: number): number | null {
  if (p.progress && p.progress.state !== "indeterminate") return p.progress.percent / 100;
  const cp = p.checkpoints[i]!;
  if (cp.prevMs === undefined) return null;
  const before = i > 0 ? p.checkpoints[i - 1]! : undefined;
  const from = before?.reachedAt ?? p.startedAt;
  const expected = cp.prevMs - (before?.prevMs ?? 0);
  if (expected <= 0) return null;
  return Math.min(0.95, (now - from) / expected);
}

/** The checkpoints as a track: a segment leading to each one. */
export function CheckpointTrack({ process: p, now }: { process: Process; now: number }) {
  const current = p.checkpoints.findIndex((c) => !c.reachedAt);
  const running = isRunning(p);
  return (
    <div className="flex gap-1" role="list" aria-label="Checkpoints">
      {p.checkpoints.map((c, i) => {
        const reached = !!c.reachedAt;
        const isCurrent = i === current;
        const fraction = reached ? 1 : isCurrent && running ? currentFraction(p, i, now) : 0;
        const broke = isCurrent && failed(p);
        return (
          <div key={`${i}:${c.label}`} role="listitem" className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-1">
              <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                {fraction === null ? (
                  <div className="absolute inset-0 animate-pulse rounded-full bg-primary/40" />
                ) : (
                  <div
                    className={cn("h-full rounded-full transition-[width] duration-500", reached ? "bg-live" : "bg-primary")}
                    style={{ width: `${fraction * 100}%` }}
                  />
                )}
                {broke && <div className="absolute inset-0 rounded-full bg-destructive/50" />}
              </div>
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full border",
                  reached && "border-live bg-live",
                  isCurrent && running && "animate-pulse border-primary",
                  broke && "border-destructive",
                )}
              />
            </div>
            <CheckpointLabel checkpoint={c} startedAt={p.startedAt} />
          </div>
        );
      })}
    </div>
  );
}

function CheckpointLabel({ checkpoint: c, startedAt }: { checkpoint: ProcessCheckpoint; startedAt: number }) {
  const at = c.reachedAt ? formatDuration((c.reachedAt - startedAt) / 1000) : undefined;
  const prev = c.prevMs !== undefined ? formatDuration(c.prevMs / 1000) : undefined;
  return (
    <span
      className={cn("truncate text-right text-[10px]", c.reachedAt ? "text-foreground/80" : "text-muted-foreground")}
      title={[c.label, at && `reached after ${at}`, !at && prev && `last run: ${prev}`].filter(Boolean).join(" — ")}
    >
      {c.label}
      {at && <span className="ml-1 text-muted-foreground tabular-nums">{at}</span>}
    </span>
  );
}

/** A counter (with a bar) or a number (with a sparkline); rate and ETA only while it runs. */
export function StatRow({ stat: s, live }: { stat: ProcessStat; live: boolean }) {
  const name = s.label || s.key;
  if (s.total !== undefined) {
    const pct = s.total > 0 ? Math.min(100, (100 * s.value) / s.total) : 0;
    const extra = [
      `${Math.floor(pct)}%`,
      live && s.rate ? formatRate(s.rate) : undefined,
      live && s.eta !== undefined ? `~${formatDuration(s.eta)} left` : undefined,
    ].filter(Boolean);
    return (
      <div className="grid gap-1 text-xs">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <span className="shrink-0 tabular-nums">
            {formatNumber(s.value)}/{formatNumber(s.total)}
            {s.unit ? ` ${s.unit}` : ""}
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums">{extra.join(" · ")}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {s.history && s.history.length > 1 && <Sparkline values={s.history} />}
      <span className="shrink-0 tabular-nums">
        {formatNumber(s.value)}
        {s.unit ? ` ${s.unit}` : ""}
      </span>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 56;
  const h = 14;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 1 - ((v - lo) / span) * (h - 2)).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0 text-primary" aria-hidden>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}

/** Terminal progress (OSC 9;4), for a process with no checkpoints. */
export function TerminalProgress({ process: p }: { process: Process }) {
  const prog = p.progress;
  if (!prog) return null;
  return (
    <div className="relative h-1.5 overflow-hidden rounded-full bg-muted" aria-label="Progress">
      {prog.state === "indeterminate" ? (
        <div className="absolute inset-0 animate-pulse rounded-full bg-primary/40" />
      ) : (
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            prog.state === "error" ? "bg-destructive" : prog.state === "paused" ? "bg-warn" : "bg-primary",
          )}
          style={{ width: `${prog.percent}%` }}
        />
      )}
    </div>
  );
}

/** Ticks every second while anything is running, for elapsed times and estimates. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return on ? now : Date.now();
}

export function statusLabel(p: Process): string {
  switch (p.status) {
    case "running":
      return p.command ? "" : "tracking";
    case "exited":
      return p.exitCode === 0 ? "exited" : `exited ${p.exitCode ?? ""}`;
    case "failed":
      return "failed to start";
    case "lost":
      return "lost when the daemon restarted";
    default:
      return p.status;
  }
}

export function StatusMark({ process: p }: { process: Process }) {
  if ((p.status === "exited" && p.exitCode === 0) || p.status === "done") {
    return <CheckIcon className="size-3.5 shrink-0 text-live" aria-label="Done" />;
  }
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        p.status === "running" && (p.command ? "animate-pulse bg-live" : "bg-primary"),
        failed(p) && "bg-destructive",
        p.status === "stopped" && "bg-muted-foreground/50",
      )}
    />
  );
}

