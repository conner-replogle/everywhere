// The Scratch section of the sidebar: per device, its newest Scratch
// threads, a way to start one, and the device's page a click away.

import type { ThreadKind } from "@everywhere/protocol";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ChevronRightIcon, MonitorIcon, PlusIcon } from "lucide-react";
import { canScratch, deviceName, scratchProject, scratchThreads, startScratch } from "@/components/scratch";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { DeviceContextValue } from "@/components/device-context";
import { SCRATCH_IDLE_AFTER_MS } from "@/lib/idle-threads";
import { cn, errorMessage } from "@/lib/utils";
import type { SidebarSectionProps } from "../types";

/** How many Scratch threads a device shows in the sidebar; the rest are on its page. */
const SCRATCH_SHOWN = 5;
/** The Scratch section as a whole, in the same collapsed set as its devices. */
const SECTION_KEY = "scratch";
const IDLE_DAYS = Math.round(SCRATCH_IDLE_AFTER_MS / (24 * 60 * 60 * 1000));

export function ScratchSection({ entries, collapsed, toggle, threadRow, split, tucked, newThreadItems, onError }: SidebarSectionProps) {
  const navigate = useNavigate();
  const { deviceId: activeDeviceId, threadId: activeThreadId } = useParams({ strict: false });
  const rows = entries.filter((e) => !!scratchProject(e)).sort((a, b) => deviceName(a).localeCompare(deviceName(b)));
  if (rows.length === 0) return null;

  async function start(entry: DeviceContextValue, kind: ThreadKind) {
    onError(null);
    try {
      const t = await startScratch(entry, kind);
      const key = `scratch:${entry.deviceId}`;
      if (collapsed.has(key)) toggle(key);
      await navigate({ to: "/d/$deviceId/t/$threadId", params: { deviceId: entry.deviceId, threadId: t.id } });
    } catch (e) {
      onError(errorMessage(e));
    }
  }

  const sectionCollapsed = collapsed.has(SECTION_KEY);
  const threadCount = rows.reduce((n, e) => n + scratchThreads(e).length, 0);

  return (
    <div className="max-h-[40%] shrink-0 overflow-y-auto border-b px-1.5 pt-1 pb-1.5">
      <button
        type="button"
        onClick={() => toggle(SECTION_KEY)}
        className="flex h-7 w-full items-center gap-1.5 rounded-md pl-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none pointer-coarse:h-9"
        aria-expanded={!sectionCollapsed}
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", !sectionCollapsed && "rotate-90")} />
        Scratch
        {sectionCollapsed && threadCount > 0 && <span className="tabular-nums">{threadCount}</span>}
      </button>
      {!sectionCollapsed && (
        <ul className="flex flex-col gap-px">
          {rows.map((entry) => {
            const key = `scratch:${entry.deviceId}`;
            const isCollapsed = collapsed.has(key);
            const all = scratchThreads(entry);
            const { listed: threads, ...part } = split(entry, all, SCRATCH_IDLE_AFTER_MS);
            const live = canScratch(entry);
            const onPage = entry.deviceId === activeDeviceId && !activeThreadId;
            return (
              <li key={key} className={cn(entry.conn.state !== "connected" && "opacity-50")}>
                <div
                  className={cn(
                    "group flex h-7 items-center rounded-md pr-1 pointer-coarse:h-10",
                    onPage ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    className="flex h-full shrink-0 items-center rounded-md pl-1.5 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                    aria-expanded={!isCollapsed}
                    aria-label={isCollapsed ? `Show ${deviceName(entry)}'s Scratch threads` : `Hide ${deviceName(entry)}'s Scratch threads`}
                  >
                    <ChevronRightIcon
                      className={cn("size-3 shrink-0 text-muted-foreground transition-transform", !isCollapsed && "rotate-90")}
                    />
                  </button>
                  <Link
                    to="/d/$deviceId"
                    params={{ deviceId: entry.deviceId }}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-1.5 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                    title={`${deviceName(entry)}: Scratch, home and projects`}
                  >
                    <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{deviceName(entry)}</span>
                    {isCollapsed && threads.length > 0 && (
                      <span className="text-xs text-muted-foreground tabular-nums">{threads.length}</span>
                    )}
                  </Link>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!live}
                        className="hidden group-hover:inline-flex focus-visible:inline-flex data-[state=open]:inline-flex pointer-coarse:inline-flex pointer-coarse:size-8"
                        aria-label={`New Scratch thread on ${deviceName(entry)}`}
                        title="New Scratch thread"
                      >
                        <PlusIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuLabel>New in a fresh Scratch folder</DropdownMenuLabel>
                      {newThreadItems(entry, (kind) => void start(entry, kind))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {!isCollapsed && (
                  <ul className="flex flex-col gap-px pb-1">
                    {threads.slice(0, SCRATCH_SHOWN).map((t) => threadRow(entry, t))}
                    {tucked(key, entry, part, IDLE_DAYS)}
                    {threads.length > SCRATCH_SHOWN && (
                      <li>
                        <Link
                          to="/d/$deviceId"
                          params={{ deviceId: entry.deviceId }}
                          className="flex h-6 items-center pl-7 text-xs text-muted-foreground hover:text-foreground pointer-coarse:h-9"
                        >
                          All {all.length} on {deviceName(entry)}
                        </Link>
                      </li>
                    )}
                    {all.length === 0 && live && (
                      <li>
                        <Link
                          to="/d/$deviceId"
                          params={{ deviceId: entry.deviceId }}
                          className="flex h-6 items-center gap-1.5 pl-7 text-xs text-muted-foreground hover:text-foreground pointer-coarse:h-9"
                        >
                          <PlusIcon className="size-3" />
                          Start something on {deviceName(entry)}
                        </Link>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
