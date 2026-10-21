// The agent plugin: Claude Code threads and tabs, and Settings → Claude.

import type { AgentStatus } from "@everywhere/protocol";
import { SparklesIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { getPrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { definePlugin, isLocal } from "../types";

// Loaded on demand so terminal-only use skips the markdown stack.
const AgentView = lazy(() => import("@/components/agent/agent-view").then((m) => ({ default: m.AgentView })));

export const agent = definePlugin({
  id: "agent",
  title: "Claude Code",
  requires: { plugins: ["agent"], features: ["claude"] },
  tabs: [
    {
      kind: "claude",
      title: "Claude",
      icon: SparklesIcon,
      createParams: async () => {
        const mode = (await getPrefs()).defaultPermissionMode;
        return mode ? { permissionMode: mode } : {};
      },
      // Closing a claude tab deletes its conversation.
      confirmClose: (p) =>
        !isLocal(p) && p.lastOpenedAt
          ? { title: "Close Claude tab?", description: "Its conversation is deleted with it.", confirmLabel: "Close tab" }
          : null,
      render: (ctx) => (
        <Suspense>
          <AgentView
            // Restoring reattaches: archiving closed the thread's session.
            key={`${ctx.pane.id}:${ctx.archived}`}
            archived={ctx.pane.id === ctx.threadId && ctx.archived ? { onRestore: () => void ctx.restore(), error: ctx.error } : undefined}
            peer={ctx.peer}
            threadId={ctx.pane.id}
            projectId={ctx.thread.projectId}
            generation={ctx.generation}
            cwd={ctx.cwd}
            scratch={ctx.inScratch}
            onToolUses={(uses) => ctx.emit("agent.toolUses", { paneId: ctx.pane.id, uses })}
            onInteract={ctx.keep}
            aboveComposer={ctx.slot("composer.above")}
            filters={ctx.plugins.flatMap((p) => p.timeline?.filters ?? []).filter((f) => !f.when || f.when(ctx))}
          />
        </Suspense>
      ),
      status: (p) => <AgentStatusLabel status={!isLocal(p) ? p.agentStatus : undefined} />,
    },
  ],
  settings: [{ to: "/settings/claude", label: "Claude", icon: SparklesIcon, order: 20 }],
});

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
