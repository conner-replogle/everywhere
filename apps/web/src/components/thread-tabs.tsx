import { Link, useNavigate } from "@tanstack/react-router";
import { PinIcon, SparklesIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { ThreadStatusDot } from "@/components/app-sidebar";
import { useFleet } from "@/components/fleet";
import { useForegroundDwell } from "@/lib/dwell";
import {
  forgetThread,
  PREVIEW_DWELL_MS,
  type RecentThread,
  retainThread,
  useRecentThreads,
} from "@/lib/recent-threads";
import { cn } from "@/lib/utils";

/**
 * The threads opened recently in this browser, from any device, as tabs; the
 * open one is highlighted. A thread only looked at has the preview tab
 * (italic), which the next thread opened replaces; see recent-threads.ts.
 */
export function ThreadTabs({ deviceId, threadId, title }: { deviceId: string; threadId: string; title?: string }) {
  const recent = useRecentThreads();
  const { entries } = useFleet();
  const navigate = useNavigate();

  // Threads deleted elsewhere drop out once their device's list says so.
  useEffect(() => {
    for (const r of recent) {
      const list = entries.get(r.deviceId)?.threads.data;
      if (list && !list.some((t) => t.id === r.threadId)) forgetThread(r.deviceId, r.threadId);
    }
  }, [recent, entries]);

  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [deviceId, threadId]);

  // Looking at the preview long enough keeps it.
  const previewing = recent.some((r) => r.preview && r.deviceId === deviceId && r.threadId === threadId);
  useForegroundDwell(previewing, PREVIEW_DWELL_MS, `${deviceId}/${threadId}`, () => retainThread(deviceId, threadId));

  const close = (r: RecentThread, active: boolean) => {
    if (active) {
      const i = recent.indexOf(r);
      const next = recent[i + 1] ?? recent[i - 1];
      if (next) navigate({ to: "/d/$deviceId/t/$threadId", params: { deviceId: next.deviceId, threadId: next.threadId } });
      else navigate({ to: "/" });
    }
    forgetThread(r.deviceId, r.threadId);
  };

  return (
    <nav aria-label="Recent threads" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
      {recent.map((r) => {
        const entry = entries.get(r.deviceId);
        const thread = entry?.threads.data?.find((t) => t.id === r.threadId);
        const active = r.deviceId === deviceId && r.threadId === threadId;
        const name = thread?.name ?? r.name;
        const project = thread && entry?.projects.data?.find((p) => p.id === thread.projectId);
        const where = [project?.name, entry?.device.name].filter(Boolean).join(" · ");
        const Icon = (thread?.kind ?? r.kind) === "claude" ? SparklesIcon : SquareTerminalIcon;
        const label = (active && title) || (where ? `${name} — ${where}` : name);
        return (
          <div
            key={`${r.deviceId}/${r.threadId}`}
            ref={active ? activeRef : undefined}
            className={cn(
              "group flex h-7 shrink-0 items-center rounded-md text-xs",
              active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60",
              entry?.conn.state !== "connected" && !active && "opacity-50",
            )}
          >
            <Link
              to="/d/$deviceId/t/$threadId"
              params={{ deviceId: r.deviceId, threadId: r.threadId }}
              aria-current={active ? "page" : undefined}
              onAuxClick={(e) => e.button === 1 && (e.preventDefault(), close(r, active))}
              onDoubleClick={() => r.preview && retainThread(r.deviceId, r.threadId)}
              title={r.preview ? `${label}\nPreview — double-click to keep the tab open` : label}
              className="flex h-full max-w-48 items-center gap-1.5 rounded-md pr-1 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <Icon className={cn("size-3.5 shrink-0", active && "text-primary")} />
              <span className={cn("truncate", active && "font-medium", r.preview && "italic")}>{name}</span>
              {r.preview && <span className="sr-only">(preview)</span>}
              {thread && <ThreadStatusDot thread={thread} />}
            </Link>
            {r.preview && (
              <button
                type="button"
                aria-label={`Keep ${name} open`}
                title="Keep open"
                onClick={() => retainThread(r.deviceId, r.threadId)}
                className={cn(
                  "rounded-sm p-0.5 hover:bg-accent hover:text-foreground",
                  !active && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100",
                )}
              >
                <PinIcon className="size-3" />
              </button>
            )}
            <button
              type="button"
              aria-label={`Close ${name}`}
              onClick={() => close(r, active)}
              className={cn(
                "mr-1 rounded-sm p-0.5 hover:bg-accent hover:text-foreground",
                !active && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100",
              )}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        );
      })}
    </nav>
  );
}
