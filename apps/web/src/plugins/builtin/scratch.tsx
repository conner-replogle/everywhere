// The Scratch plugin: a Scratch thread's link back to its device, and the
// actions that move work between Scratch and projects.

import { FolderInputIcon, FolderPlusIcon, FolderTreeIcon, MonitorIcon, MoreHorizontalIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ContinueDialog, PromoteDialog } from "@/components/scratch-actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { definePlugin, type ThreadContext } from "../types";
import { changeItems } from "./scratch-changes";
import { ScratchDevice } from "./scratch-device";
import { ScratchSection } from "./scratch-sidebar";

function ScratchLink({ ctx }: { ctx: ThreadContext }) {
  if (!ctx.inScratch) return null;
  return (
    <Link
      to="/d/$deviceId"
      params={{ deviceId: ctx.deviceId }}
      className="hidden shrink-0 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground sm:block"
      title="Scratch: this thread works in a folder of its own"
    >
      Scratch
    </Link>
  );
}

function ThreadActions({ ctx }: { ctx: ThreadContext }) {
  const [moving, setMoving] = useState<"promote" | "continue" | "toScratch" | null>(null);
  const { thread, inScratch, scratchProject: scratch } = ctx;
  if (ctx.archived || !(inScratch || (thread.kind === "claude" && scratch))) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Thread actions" title="Thread actions">
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {inScratch && ctx.canTab && (
            <DropdownMenuItem onSelect={() => void ctx.openTab("files")}>
              <FolderTreeIcon />
              Open its folder
            </DropdownMenuItem>
          )}
          {inScratch && (
            <DropdownMenuItem onSelect={() => setMoving("promote")}>
              <FolderPlusIcon />
              Make this a project…
            </DropdownMenuItem>
          )}
          {thread.kind === "claude" && (
            <>
              {inScratch && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => setMoving("continue")}>
                <FolderInputIcon />
                Continue in a project…
              </DropdownMenuItem>
              {!inScratch && scratch && (
                <DropdownMenuItem onSelect={() => setMoving("toScratch")}>
                  <MonitorIcon />
                  Continue in Scratch…
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <PromoteDialog entry={ctx.entry} thread={thread} open={moving === "promote"} onOpenChange={(o) => !o && setMoving(null)} />
      <ContinueDialog
        entry={ctx.entry}
        thread={thread}
        open={moving === "continue" || moving === "toScratch"}
        only={moving === "toScratch" ? scratch : undefined}
        onOpenChange={(o) => !o && setMoving(null)}
      />
    </>
  );
}

export const scratch = definePlugin({
  id: "scratch",
  title: "Scratch",
  requires: { plugins: ["scratch"], features: ["scratch"] },
  threadHeader: [ScratchLink, ThreadActions],
  device: { sections: [{ order: 10, component: ScratchDevice }] },
  sidebar: { sections: [{ order: 10, component: ScratchSection }] },
  timeline: {
    filters: [
      {
        id: "changes",
        label: "Changes to this computer",
        title: "Files Claude changed outside this thread's folder, commands that change the system, and using the screen",
        when: (ctx) => ctx.inScratch,
        apply: (items, cwd) => changeItems(items as Parameters<typeof changeItems>[0], cwd),
      },
    ],
  },
});
