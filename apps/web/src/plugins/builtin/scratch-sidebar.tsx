// The Scratch section of the sidebar: the Scratch threads in use, on every
// device, pinned then newest first, and a + to start one on a device. Idle
// and done ones are under an "N earlier" row that opens in place (and on
// each device's page).

import type { ThreadKind } from "@everywhere/protocol";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, HistoryIcon, PlusIcon } from "lucide-react";
import { Fragment, useState } from "react";
import { canScratch, deviceName, scratchProject, scratchThreads, startScratch, threadRecency } from "@/components/scratch";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DeviceContextValue } from "@/components/device-context";
import { SCRATCH_IDLE_AFTER_MS } from "@/lib/idle-threads";
import { cn, errorMessage } from "@/lib/utils";
import type { SidebarSectionProps } from "../types";

/** In the sidebar's collapsed set when the section is open: it starts collapsed. */
const OPEN_KEY = "scratch:open";

export function ScratchSection({ entries, collapsed, toggle, threadRow, split, newThreadItems, onError }: SidebarSectionProps) {
  const navigate = useNavigate();
  const [earlierOpen, setEarlierOpen] = useState(false);
  const devices = entries.filter((e) => !!scratchProject(e)).sort((a, b) => deviceName(a).localeCompare(deviceName(b)));
  if (devices.length === 0) return null;
  const startable = devices.filter(canScratch);

  async function start(entry: DeviceContextValue, kind: ThreadKind) {
    onError(null);
    try {
      const t = await startScratch(entry, kind);
      if (!collapsed.has(OPEN_KEY)) toggle(OPEN_KEY);
      await navigate({ to: "/d/$deviceId/t/$threadId", params: { deviceId: entry.deviceId, threadId: t.id } });
    } catch (e) {
      onError(errorMessage(e));
    }
  }

  // What's in use (pinned, or neither done nor idle a while), and the rest, tucked under "earlier".
  const parts = devices.map((entry) => ({ entry, ...split(entry, scratchThreads(entry), SCRATCH_IDLE_AFTER_MS) }));
  const active = parts
    .flatMap(({ entry, listed }) => listed.map((t) => ({ entry, t })))
    .sort((a, b) => Number(!!b.t.pinnedAt) - Number(!!a.t.pinnedAt) || threadRecency(b.t) - threadRecency(a.t));
  const earlier = parts
    .flatMap(({ entry, done, idle }) => [...done, ...idle].map((t) => ({ entry, t })))
    .sort((a, b) => threadRecency(b.t) - threadRecency(a.t));
  const sectionCollapsed = !collapsed.has(OPEN_KEY);
  const detail = (entry: DeviceContextValue) => (devices.length > 1 ? deviceName(entry) : undefined);

  return (
    <div className="max-h-[40%] shrink-0 overflow-y-auto border-b px-1.5 pt-1 pb-1.5">
      <div className="group flex h-7 items-center pr-1 pointer-coarse:h-9">
        <button
          type="button"
          onClick={() => toggle(OPEN_KEY)}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          aria-expanded={!sectionCollapsed}
        >
          <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", !sectionCollapsed && "rotate-90")} />
          Scratch
          {sectionCollapsed && active.length > 0 && <span className="tabular-nums">{active.length}</span>}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={startable.length === 0}
              className="pointer-coarse:size-8"
              aria-label="New Scratch thread"
              title="New Scratch thread, in a fresh folder"
            >
              <PlusIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {startable.map((entry, i) => (
              <Fragment key={entry.deviceId}>
                {i > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel>{startable.length > 1 ? `On ${deviceName(entry)}` : "New in a fresh Scratch folder"}</DropdownMenuLabel>
                {newThreadItems(entry, (kind) => void start(entry, kind))}
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {!sectionCollapsed && (active.length > 0 || earlier.length > 0) && (
        <ul className="flex flex-col gap-px">
          {active.map(({ entry, t }) => threadRow(entry, t, { flat: true, detail: detail(entry) }))}
          {earlier.length > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setEarlierOpen((o) => !o)}
                aria-expanded={earlierOpen}
                title="Done, or untouched for a day or more. Nothing in them is stopped or deleted; Pin one to keep it listed."
                className="flex h-6 w-full items-center gap-1.5 rounded-md pr-2 pl-2 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none pointer-coarse:h-9"
              >
                <HistoryIcon className="size-3.5 shrink-0" />
                <span className="tabular-nums">{earlier.length} earlier</span>
                <ChevronRightIcon className={cn("ml-auto size-3 shrink-0 transition-transform", earlierOpen && "rotate-90")} />
              </button>
            </li>
          )}
          {earlierOpen && earlier.map(({ entry, t }) => threadRow(entry, t, { flat: true, idle: true, detail: detail(entry) }))}
        </ul>
      )}
    </div>
  );
}
