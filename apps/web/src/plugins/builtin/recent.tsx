// The sidebar's Recent section: the threads you've been switching between,
// across every project and device, above the projects (which stay grouped).
// They're the same threads as the tabs along the top of the thread page,
// most recently opened first, kept in this browser.

import { ChevronRightIcon } from "lucide-react";
import type { Thread } from "@everywhere/protocol";
import type { DeviceContextValue } from "@/components/device-context";
import { deviceName } from "@/components/scratch";
import { useRecentThreads } from "@/lib/recent-threads";
import { cn } from "@/lib/utils";
import { definePlugin, type SidebarSectionProps } from "../types";

/** How many the section lists. */
export const RECENT_COUNT = 5;
/** In the sidebar's collapsed set when the section is closed (it starts open). */
const CLOSED_KEY = "recent:closed";

function RecentSection({ entries, collapsed, toggle, threadRow }: SidebarSectionProps) {
  const recent = useRecentThreads();
  const byDevice = new Map(entries.map((e) => [e.deviceId, e]));
  const rows: { entry: DeviceContextValue; t: Thread }[] = [];
  for (const r of [...recent].sort((a, b) => b.visitedAt - a.visitedAt)) {
    const entry = byDevice.get(r.deviceId);
    const t = entry?.threads.data?.find((x) => x.id === r.threadId);
    if (!entry || !t || t.archivedAt) continue;
    rows.push({ entry, t });
    if (rows.length === RECENT_COUNT) break;
  }
  // Two or fewer isn't switching between threads yet.
  if (rows.length < 2) return null;
  const closed = collapsed.has(CLOSED_KEY);
  const multiDevice = entries.length > 1;
  const detail = (entry: DeviceContextValue, t: Thread) => {
    const project = entry.projects.data?.find((p) => p.id === t.projectId);
    const where = project?.isScratch ? "Scratch" : project?.name;
    return [multiDevice ? deviceName(entry) : undefined, where].filter(Boolean).join(" · ") || undefined;
  };
  return (
    <div className="shrink-0 border-b px-1.5 pt-1 pb-1.5">
      <button
        type="button"
        onClick={() => toggle(CLOSED_KEY)}
        aria-expanded={!closed}
        className="flex h-7 w-full items-center gap-1.5 rounded-md pl-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none pointer-coarse:h-9"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", !closed && "rotate-90")} />
        Recent
      </button>
      {!closed && <ul className="flex flex-col gap-px">{rows.map(({ entry, t }) => threadRow(entry, t, { flat: true, detail: detail(entry, t) }))}</ul>}
    </div>
  );
}

export const recent = definePlugin({
  id: "recent",
  title: "Recent threads",
  sidebar: { sections: [{ order: 5, component: RecentSection }] },
});
