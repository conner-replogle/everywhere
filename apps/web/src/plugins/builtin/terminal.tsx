// The terminal plugin: terminal threads and tabs.

import { ArchiveRestoreIcon, SquareTerminalIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { CenteredMessage } from "@/components/centered-message";
import type { WriterState } from "@/components/terminal-view";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { definePlugin } from "../types";

const TerminalView = lazy(() => import("@/components/terminal-view").then((m) => ({ default: m.TerminalView })));

export const terminal = definePlugin({
  id: "terminal",
  title: "Terminal",
  // Every daemon has terminals.
  tabs: [
    {
      kind: "terminal",
      title: "Terminal",
      icon: SquareTerminalIcon,
      capture: "keys",
      render: (ctx) =>
        ctx.archived && ctx.pane.id === ctx.threadId ? (
          <CenteredMessage
            title="This terminal is archived"
            body={ctx.error ?? `Its shell was stopped. Restore it to start a new shell in the ${ctx.inScratch ? "same folder" : "project"}.`}
          >
            <Button variant="outline" size="sm" onClick={() => void ctx.restore()}>
              <ArchiveRestoreIcon />
              Restore
            </Button>
          </CenteredMessage>
        ) : (
          <Suspense>
            <TerminalView
              key={ctx.pane.id}
              peer={ctx.peer}
              threadId={ctx.pane.id}
              generation={ctx.generation}
              active={ctx.shown}
              onInteract={ctx.keep}
              onWriterChange={ctx.report}
            />
          </Suspense>
        ),
      status: (_pane, reported) => <WriterLabel writer={(reported as WriterState | undefined) ?? "pending"} />,
    },
  ],
});

function WriterLabel({ writer }: { writer: WriterState }) {
  return (
    <span
      className={cn(
        "ml-auto shrink-0 rounded-sm px-1.5 py-0.5 text-xs",
        writer === "writer" && "text-live",
        writer === "viewer" && "bg-warn/10 text-warn",
        (writer === "pending" || writer === "exited") && "text-muted-foreground",
      )}
    >
      {{ writer: "Writing", viewer: "Read-only", exited: "Exited", pending: "Attaching…" }[writer]}
    </span>
  );
}
