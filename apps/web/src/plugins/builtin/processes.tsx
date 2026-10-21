// The processes plugin: the processes tab, the strip of running processes
// above claude's composer, and how process tools look in the timeline.

import type { Thread } from "@everywhere/protocol";
import { ActivityIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { ProcessesOverview } from "@/components/processes/overview";
import { definePlugin, isLocal, type PaneContext, slotViews, type ThreadContext } from "../types";

const ProcessesView = lazy(() =>
  import("@/components/processes/processes-view").then((m) => ({ default: m.ProcessesView })),
);

const TerminalView = lazy(() => import("@/components/terminal-view").then((m) => ({ default: m.TerminalView })));

const PROCESS_TOOL = /^mcp__everywhere__process_(.+)$/;
const PROCESS_START_TOOL = "mcp__everywhere__process_start";

// A process for a thread's processes tab to show, kept until the tab is
// there to take it (opening it may come first).
const pending = new Map<string, { id: string; at: number }>();

function openProcess(ctx: ThreadContext, id?: string) {
  if (id) {
    pending.set(ctx.threadId, { id, at: Date.now() });
    ctx.emit("processes.show", { id });
  }
  void ctx.openTab("processes");
}

function ProcessesPane({ ctx }: { ctx: PaneContext }) {
  const [show, setShow] = useState(() => pending.get(ctx.threadId));
  const { on } = ctx;
  useEffect(() => on("processes.show", ({ id }) => setShow({ id, at: Date.now() })), [on]);
  return (
    <Suspense>
      <ProcessesView
        peer={ctx.peer}
        threadId={ctx.threadId}
        generation={ctx.generation}
        initialState={ctx.pane.tabState}
        onStateChange={ctx.setTabState}
        onOpenUrl={ctx.openUrl}
        show={show}
        views={slotViews(ctx.plugins, "process.view")}
      />
    </Suspense>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export const processes = definePlugin({
  id: "processes",
  title: "Processes",
  requires: { plugins: ["processes"], features: ["processes"] },
  tabs: [
    {
      kind: "processes",
      title: "Processes",
      icon: ActivityIcon,
      single: true,
      render: (ctx) => <ProcessesPane ctx={ctx} />,
      badge: (p, thread) => (!isLocal(p) && p.kind === "processes" ? thread.processes : undefined),
    },
  ],
  views: {
    "process.view": [
      {
        id: "log",
        order: 30,
        label: "Log",
        when: ({ process: p }) => !!p.command,
        rank: () => 2,
        keepMounted: true,
        render: ({ peer, threadId, generation, process: p }) => (
          <Suspense>
            <TerminalView
              // A new run is a new log.
              key={`${p.id}:${p.startedAt}`}
              peer={peer}
              threadId={threadId}
              processId={p.id}
              generation={generation}
            />
          </Suspense>
        ),
      },
    ],
  },
  sidebar: { threadBadges: [RunningBadge] },
  slots: {
    "composer.above": (ctx) =>
      ctx.canTab ? (
        <ProcessesOverview
          peer={ctx.peer}
          threadId={ctx.threadId}
          onOpen={(id) => openProcess(ctx, id)}
          onOpenUrl={ctx.openUrl}
        />
      ) : null,
  },
  timeline: {
    tools: [
      {
        match: PROCESS_TOOL,
        icon: ActivityIcon,
        label: (name) => `Process · ${PROCESS_TOOL.exec(name)?.[1] ?? name}`,
        summary: (input, name) =>
          name === PROCESS_START_TOOL ? `${str(input.name)}  ${str(input.command).split("\n")[0] || "tracker"}` : undefined,
      },
    ],
  },
  on: {
    // Show processes as a tab when claude starts one, but not right after the user closed it.
    "agent.toolUses": ({ uses }, ctx) => {
      if (!ctx.canTab || ctx.closedRecently("processes", 120_000)) return;
      if (uses.some((u) => u.recent && u.name === PROCESS_START_TOOL)) void ctx.openTab("processes", { focus: false });
    },
  },
});

/** A thread's running processes, on its row in the sidebar. */
function RunningBadge({ thread: t }: { thread: Thread }) {
  if (!t.processes) return null;
  return (
    <span
      className="rounded-sm bg-live/15 px-1 text-[10px] text-live tabular-nums"
      title={`${t.processes} process${t.processes === 1 ? "" : "es"} running`}
    >
      {t.processes}
    </span>
  );
}
