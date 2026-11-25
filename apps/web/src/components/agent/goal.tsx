// Goal mode in the agent view: the bar above the composer that shows the
// thread's goal (and the wake its agent scheduled) with its controls, and
// the /goal command for the slash menu. The daemon runs the goal; this only
// shows it and sends the user's requests (see AgentGoal).

import type { AgentClientMsg, AgentCommand, AgentGoal, AgentGoalStatus, AgentWake, Thread } from "@everywhere/protocol";
import { AlarmClockIcon, PauseIcon, PlayIcon, TargetIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** /goal in the slash menu; the daemon runs it, whatever the agent. */
export const GOAL_COMMAND: AgentCommand = {
  name: "goal",
  description: "Keep working toward an objective, turn after turn, until it's done",
  argumentHint: "<objective> | pause | resume | clear",
};

/** Whether a goal keeps the agent going. */
export function goalRunning(g: AgentGoal | undefined): boolean {
  return g?.status === "active" || g?.status === "waiting";
}

const STATUS: Record<AgentGoalStatus, { label: string; tone: string }> = {
  active: { label: "Working toward the goal", tone: "text-primary" },
  waiting: { label: "Waiting", tone: "text-primary" },
  paused: { label: "Goal paused", tone: "text-warn" },
  blocked: { label: "Goal needs you", tone: "text-warn" },
  limited: { label: "Goal out of turns", tone: "text-warn" },
  complete: { label: "Goal complete", tone: "text-live" },
};

/** The thread's goal and wake, above the composer. */
export function GoalBar({
  goal,
  wake,
  name,
  disabled,
  send,
}: {
  goal: AgentGoal | undefined;
  wake: AgentWake | undefined;
  /** The agent's name. */
  name: string;
  disabled: boolean;
  send: (msg: AgentClientMsg) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!goal && !wake) return null;
  const status = goal && STATUS[goal.status];
  const running = goalRunning(goal);
  const label = goal?.audit === "running" ? "Checking the goal is done" : status?.label;
  return (
    <div className="grid gap-1.5 rounded-md border bg-card px-3 py-2 text-[13px]">
      {goal && status && (
        <div className="flex items-start gap-3">
          <TargetIcon className={cn("mt-0.5 size-4 shrink-0", status.tone, goal.status === "active" && "animate-pulse")} />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className={cn("font-medium", status.tone)}>{label}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                turn {goal.turns} of {goal.maxTurns}
              </span>
            </span>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className={cn("text-left whitespace-pre-wrap", !open && "line-clamp-2")}
              title={open ? "Show less" : "Show all"}
            >
              {goal.objective}
            </button>
            {goal.reason && <span className="text-xs text-muted-foreground">{goal.reason}</span>}
          </div>
          <div className="flex shrink-0 gap-1">
            {running ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => send({ t: "goal", action: "pause" })}
                title={`Pause: ${name} finishes its turn and stops`}
              >
                <PauseIcon />
                Pause
              </Button>
            ) : (
              goal.status !== "complete" && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => send({ t: "goal", action: "resume" })}
                  title={
                    goal.status === "limited"
                      ? "Resume with as many turns again"
                      : goal.status === "blocked"
                        ? `Resume once you've given ${name} what it needs`
                        : "Resume"
                  }
                >
                  <PlayIcon />
                  Resume
                </Button>
              )
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              className="size-7 text-muted-foreground"
              disabled={disabled}
              onClick={() => send({ t: "goal", action: "clear" })}
              aria-label={goal.status === "complete" ? "Dismiss the goal" : "Clear the goal"}
              title={goal.status === "complete" ? "Dismiss" : "Clear the goal (the current turn, if any, finishes)"}
            >
              <XIcon />
            </Button>
          </div>
        </div>
      )}
      {wake && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <AlarmClockIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={wake.reason}>
            {name} wakes {wakeTime(wake.at)}: {wake.reason}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-6"
            disabled={disabled}
            onClick={() => send({ t: "cancelWake" })}
            aria-label="Cancel the wake"
            title="Cancel the wake"
          >
            <XIcon />
          </Button>
        </div>
      )}
    </div>
  );
}

/** "at 15:40", or with the day when it isn't today. */
function wakeTime(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return today ? `at ${time}` : `${d.toLocaleDateString(undefined, { weekday: "short" })} at ${time}`;
}

/** The sidebar's mark for a thread whose goal is running or needs the user. */
export function GoalBadge({ thread: t }: { thread: Thread }) {
  const s = t.goal;
  if (s !== "active" && s !== "waiting" && s !== "blocked") return null;
  const title = s === "blocked" ? "Goal needs you" : s === "waiting" ? "Goal: waiting on a process" : "Working toward a goal";
  return (
    <span title={title} aria-label={title}>
      <TargetIcon className={cn("size-3", s === "blocked" ? "text-warn" : "text-primary")} />
    </span>
  );
}
