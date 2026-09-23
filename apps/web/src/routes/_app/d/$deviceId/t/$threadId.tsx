import { createFileRoute, Link } from "@tanstack/react-router";
import type { AgentStatus } from "@everywhere/protocol";
import { lazy, Suspense, useState } from "react";
import { CenteredMessage } from "@/components/centered-message";
import { useDevice } from "@/components/device-context";
import { TerminalView, type WriterState } from "@/components/terminal-view";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Loaded on demand so terminal-only use skips the markdown stack.
const AgentView = lazy(() => import("@/components/agent/agent-view").then((m) => ({ default: m.AgentView })));

export const Route = createFileRoute("/_app/d/$deviceId/t/$threadId")({
  component: ThreadPage,
});

function ThreadPage() {
  const { deviceId, threadId } = Route.useParams();
  const { peer, conn, threads, projects } = useDevice();
  const [writer, setWriter] = useState<WriterState>("pending");
  const thread = threads.data?.find((t) => t.id === threadId);
  const project = thread && projects.data?.find((p) => p.id === thread.projectId);

  if (threads.data && !thread) {
    return (
      <CenteredMessage title="Thread not found" body="It may have been deleted from another client.">
        <Button variant="outline" size="sm" asChild>
          <Link to="/d/$deviceId" params={{ deviceId }}>
            Back to device
          </Link>
        </Button>
      </CenteredMessage>
    );
  }

  const claude = thread?.kind === "claude";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b bg-sidebar pr-3 pl-10 md:pl-3">
        <span className="truncate font-medium">{thread?.name ?? "…"}</span>
        {project && <span className="truncate font-mono text-xs text-muted-foreground">{project.path}</span>}
        {claude ? (
          <AgentStatusLabel status={thread.agentStatus} />
        ) : (
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
        )}
      </div>
      <div className="min-h-0 flex-1">
        {/* Wait for the thread list so a claude thread never flashes a terminal. */}
        {!thread ? null : claude ? (
          <Suspense>
            <AgentView key={threadId} peer={peer} threadId={threadId} generation={conn.generation} cwd={project?.path} />
          </Suspense>
        ) : (
          <TerminalView
            key={threadId}
            peer={peer}
            threadId={threadId}
            generation={conn.generation}
            onWriterChange={setWriter}
          />
        )}
      </div>
    </div>
  );
}

const STATUS_LABELS: Record<AgentStatus, string> = {
  stopped: "Stopped",
  starting: "Starting…",
  idle: "Idle",
  working: "Working",
  waiting: "Needs you",
  error: "Error",
};

function AgentStatusLabel({ status = "stopped" }: { status?: AgentStatus }) {
  return (
    <span
      className={cn(
        "ml-auto shrink-0 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground",
        status === "working" && "text-primary",
        status === "waiting" && "bg-warn/10 text-warn",
        status === "error" && "bg-destructive/10 text-destructive",
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
