// The agent plugin: Claude Code threads and tabs, and Settings → Claude.

import type { AgentStatus, PluginInfo } from "@everywhere/protocol";
import { SparklesIcon, type LucideIcon } from "lucide-react";
import { ClaudeIcon, pluginLogoIcon } from "@/components/kind-icon";
import { lazy, Suspense } from "react";
import { getPrefs } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { definePlugin, isLocal, type TabKindDef } from "../types";

// Loaded on demand so terminal-only use skips the markdown stack.
const AgentView = lazy(() => import("@/components/agent/agent-view").then((m) => ({ default: m.AgentView })));

export const agent = definePlugin({
  id: "agent",
  title: "Claude Code",
  requires: { plugins: ["agent"], features: ["claude"] },
  tabs: [
    agentTab("claude", "Claude", ClaudeIcon as unknown as LucideIcon, {
      createParams: async () => {
        const mode = (await getPrefs()).defaultPermissionMode;
        return mode ? { permissionMode: mode } : {};
      },
    }),
  ],
  settings: [{ to: "/settings/claude", label: "Claude", icon: SparklesIcon, order: 20 }],
});

/** A tab kind drawn with the agent view: Claude's, or another agent's the device runs. */
function agentTab(kind: string, title: string, icon: LucideIcon, extra: Partial<TabKindDef> = {}): TabKindDef {
  return {
    kind,
    title,
    icon,
    // Closing an agent tab deletes its conversation.
    confirmClose: (p) =>
      !isLocal(p) && p.lastOpenedAt
        ? { title: `Close ${title} tab?`, description: "Its conversation is deleted with it.", confirmLabel: "Close tab" }
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
    ...extra,
  };
}

/** The kinds a device's plugins want drawn with the agent view (other agents than Claude). */
export function agentViewKinds(plugins: readonly PluginInfo[] | undefined): TabKindDef[] {
  return (plugins ?? []).flatMap((p) =>
    (p.contributes.kinds ?? [])
      .filter((k) => k.view === "agent" && k.kind !== "claude")
      .map((k) => agentTab(k.kind, k.title || k.kind, pluginLogoIcon(k.icon ?? p.icon))),
  );
}

/** Whether a kind is an agent's (drawn with the agent view). */
export function isAgentKind(kind: string, plugins: readonly PluginInfo[] | undefined): boolean {
  return kind === "claude" || (plugins ?? []).some((p) => p.contributes.kinds?.some((k) => k.kind === kind && k.view === "agent"));
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
