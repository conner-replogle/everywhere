import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { AgentStatus, Tab, TabKind, Thread } from "@everywhere/protocol";
import {
  ArchiveRestoreIcon,
  FolderTreeIcon,
  GlobeIcon,
  type LucideIcon,
  PlusIcon,
  SparklesIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { CenteredMessage } from "@/components/centered-message";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useDevice } from "@/components/device-context";
import { RenameDialog } from "@/components/rename-dialog";
import { TerminalView, type WriterState } from "@/components/terminal-view";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sendToComposer } from "@/lib/composer-inbox";
import { useRpc } from "@/lib/peer";
import { cn, errorMessage } from "@/lib/utils";

// Loaded on demand so terminal-only use skips the markdown stack.
const AgentView = lazy(() => import("@/components/agent/agent-view").then((m) => ({ default: m.AgentView })));
const BrowserView = lazy(() => import("@/components/browser/browser-view").then((m) => ({ default: m.BrowserView })));
const FilesView = lazy(() => import("@/components/files/files-view").then((m) => ({ default: m.FilesView })));

const KIND_ICON: Record<TabKind, LucideIcon> = {
  terminal: SquareTerminalIcon,
  claude: SparklesIcon,
  browser: GlobeIcon,
  files: FolderTreeIcon,
};

const KIND_LABEL: Record<TabKind, string> = {
  terminal: "Terminal",
  claude: "Claude",
  browser: "Browser",
  files: "Files",
};

/** The thread itself, or one of its tabs. */
type Pane = (Thread & { parentId?: undefined; tabState?: undefined }) | Tab;

export const Route = createFileRoute("/_app/_workspace/d/$deviceId/t/$threadId")({
  validateSearch: (search: Record<string, unknown>): { tab?: string } =>
    typeof search.tab === "string" ? { tab: search.tab } : {},
  component: ThreadPage,
});

function ThreadPage() {
  const { threadId } = Route.useParams();
  const { tab: tabParam } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { peer, conn, threads, projects, info } = useDevice();
  const features = info.data?.features ?? [];
  const thread = threads.data?.find((t) => t.id === threadId);
  const project = thread && projects.data?.find((p) => p.id === thread.projectId);
  const archived = !!thread?.archivedAt;
  const canTab = features.includes("tabs") && !archived;
  const tabs = useRpc(peer, "tabs.list", { threadId }, ["threads.changed"], canTab);
  const workdir = useRpc(peer, "threads.workdir", { id: threadId }, ["threads.changed"], canTab);

  // Daemons from before tabs still have their project's browser, as a fixed tab.
  const legacyBrowser = !!info.data && !features.includes("tabs") && !archived && !!thread;
  const legacyTab: Tab | undefined =
    legacyBrowser && thread
      ? { ...thread, id: `${thread.id}:browser`, kind: "browser", name: "Browser", parentId: thread.id }
      : undefined;
  const panes: Pane[] = thread
    ? [thread, ...(canTab ? (tabs.data ?? []) : []), ...(legacyTab ? [legacyTab] : [])]
    : [];
  // A tab that's gone (closed elsewhere) falls back to the thread.
  const active = panes.find((p) => p.id === tabParam) ?? thread;
  const setActive = (id: string) =>
    navigate({ search: id === threadId ? {} : { tab: id }, replace: true, resetScroll: false });

  // Terminal and claude panes stay mounted once opened, so switching tabs
  // keeps their scrollback and drafts. The browser only streams while shown.
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const activeId = active?.id;
  // Before the effect below, so a new thread starts empty and then opens.
  useEffect(() => setOpened(new Set()), [threadId]);
  useEffect(() => {
    if (activeId) setOpened((s) => (s.has(activeId) ? s : new Set(s).add(activeId)));
  }, [activeId]);

  const [writers, setWriters] = useState<Record<string, WriterState>>({});
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Tab | null>(null);
  const [closing, setClosing] = useState<Tab | null>(null);
  const browserClosedAt = useRef(0);

  const restore = async () => {
    setError(null);
    try {
      await peer.call("threads.archive", { id: threadId, archived: false });
      threads.refetch();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const openTab = async (kind: TabKind, focus = true) => {
    // One browser per thread: a second tab would show the same page.
    const existing = kind === "browser" && tabs.data?.find((t) => t.kind === "browser");
    if (existing) {
      if (focus) setActive(existing.id);
      return;
    }
    setError(null);
    try {
      const t = await peer.call("tabs.create", { threadId, kind });
      tabs.refetch();
      if (focus) setActive(t.id);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const closeTab = async (t: Tab) => {
    if (t.kind === "browser") browserClosedAt.current = Date.now();
    if (active?.id === t.id) {
      const i = panes.findIndex((p) => p.id === t.id);
      setActive((panes[i + 1] ?? panes[i - 1] ?? thread!).id);
    }
    await peer.call("tabs.close", { id: t.id });
    tabs.refetch();
  };

  if (threads.data && !thread) {
    return (
      <CenteredMessage title="Thread not found" body="It may have been deleted from another client.">
        <Button variant="outline" size="sm" asChild>
          <Link to="/">Back to projects</Link>
        </Button>
      </CenteredMessage>
    );
  }

  // Annotations from the browser go to the thread's claude, or else the last
  // claude tab opened here (only a mounted one has a composer to take them).
  const claudeTarget =
    thread?.kind === "claude"
      ? thread.id
      : [...opened].reverse().find((id) => panes.find((p) => p.id === id)?.kind === "claude");
  const onBrowserUse = () => {
    // Open the browser as a tab, but not right after the user closed it.
    if (!canTab || Date.now() - browserClosedAt.current < 120_000) return;
    void openTab("browser", false);
  };

  const renderPane = (p: Pane) => {
    if (!thread) return null;
    switch (p.kind) {
      case "claude":
        return (
          <Suspense>
            <AgentView
              // Restoring reattaches: archiving closed the thread's session.
              key={`${p.id}:${archived}`}
              archived={p.id === threadId && archived ? { onRestore: restore, error } : undefined}
              peer={peer}
              threadId={p.id}
              projectId={thread.projectId}
              generation={conn.generation}
              cwd={project?.path}
              onBrowserUse={onBrowserUse}
            />
          </Suspense>
        );
      case "terminal":
        return archived ? (
          <CenteredMessage
            title="This terminal is archived"
            body={error ?? "Its shell was stopped. Restore it to start a new shell in the project."}
          >
            <Button variant="outline" size="sm" onClick={restore}>
              <ArchiveRestoreIcon />
              Restore
            </Button>
          </CenteredMessage>
        ) : (
          <TerminalView
            key={p.id}
            peer={peer}
            threadId={p.id}
            generation={conn.generation}
            active={p.id === active?.id}
            onWriterChange={(w) => setWriters((ws) => (ws[p.id] === w ? ws : { ...ws, [p.id]: w }))}
          />
        );
      case "browser":
        return (
          <Suspense>
            <BrowserView
              peer={peer}
              threadId={legacyBrowser ? thread.projectId : threadId}
              generation={conn.generation}
              remoteOs={info.data?.os}
              onAnnotate={
                claudeTarget
                  ? (draft) => {
                      if (!sendToComposer(claudeTarget, draft)) return false;
                      setActive(claudeTarget);
                      return true;
                    }
                  : undefined
              }
            />
          </Suspense>
        );
      case "files":
        return (
          <Suspense>
            <FilesView
              peer={peer}
              root={workdir.data?.path ?? project?.path ?? "~"}
              initialState={p.tabState}
              onStateChange={(state) => void peer.call("tabs.setState", { id: p.id, state }).catch(() => {})}
            />
          </Suspense>
        );
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b bg-sidebar pr-3 pl-10 md:pl-3">
        <span className="truncate font-medium">{thread?.name ?? "…"}</span>
        {project && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {workdir.data?.worktree ? workdir.data.path : project.path}
          </span>
        )}
        {archived ? (
          <span className="ml-auto shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            Archived
          </span>
        ) : active?.kind === "claude" ? (
          <AgentStatusLabel status={active.agentStatus} />
        ) : active?.kind === "terminal" ? (
          <WriterLabel writer={writers[active.id] ?? "pending"} />
        ) : null}
      </div>
      {(canTab || legacyBrowser) && thread && (
        <div className="flex h-8 shrink-0 items-stretch border-b bg-sidebar">
          <div role="tablist" aria-label="Tabs" className="flex min-w-0 items-stretch overflow-x-auto">
            {panes.map((p) => (
              <TabButton
                key={p.id}
                pane={p}
                active={p.id === active?.id}
                onSelect={() => setActive(p.id)}
                onRename={p.parentId && canTab ? () => setRenaming(p as Tab) : undefined}
                onClose={
                  p.parentId && canTab
                    ? () => {
                        const t = p as Tab;
                        // Closing a claude tab deletes its conversation.
                        if (t.kind === "claude" && t.lastOpenedAt) setClosing(t);
                        else void closeTab(t).catch((e: unknown) => setError(errorMessage(e)));
                      }
                    : undefined
                }
              />
            ))}
          </div>
          {canTab && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="mx-1 self-center" aria-label="New tab" title="New tab">
                  <PlusIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {(["terminal", "claude", "browser", "files"] as const)
                  .filter((k) => k !== "claude" || features.includes("claude"))
                  .map((k) => {
                    const Icon = KIND_ICON[k];
                    return (
                      <DropdownMenuItem key={k} onSelect={() => void openTab(k)}>
                        <Icon />
                        {KIND_LABEL[k]}
                      </DropdownMenuItem>
                    );
                  })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {error && !archived && (
            <span className="ml-auto self-center truncate px-3 text-xs text-destructive" title={error}>
              {error}
            </span>
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {/* Panes wait for the thread list, so a claude thread never flashes a terminal. */}
        {panes
          .filter((p) => p.id === active?.id || (p.kind !== "browser" && opened.has(p.id)))
          .map((p) => (
            <div
              key={p.id}
              role="tabpanel"
              // Hidden panes keep their size, so terminals don't resize.
              className={cn("absolute inset-0", p.id !== active?.id && "invisible")}
            >
              {renderPane(p)}
            </div>
          ))}
      </div>
      <RenameDialog
        open={!!renaming}
        onOpenChange={(o) => !o && setRenaming(null)}
        title="Rename tab"
        initial={renaming?.name ?? ""}
        onSubmit={async (name) => {
          await peer.call("threads.rename", { id: renaming!.id, name });
          tabs.refetch();
        }}
      />
      <ConfirmDialog
        open={!!closing}
        onOpenChange={(o) => !o && setClosing(null)}
        title="Close Claude tab?"
        description="Its conversation is deleted with it."
        confirmLabel="Close tab"
        onConfirm={() => closeTab(closing!)}
      />
    </div>
  );
}

function TabButton({
  pane: p,
  active,
  onSelect,
  onRename,
  onClose,
}: {
  pane: Pane;
  active: boolean;
  onSelect: () => void;
  onRename?: () => void;
  onClose?: () => void;
}) {
  const Icon = KIND_ICON[p.kind];
  // The thread's own tab is named by its kind; the thread's name is above.
  const label = p.parentId ? p.name : KIND_LABEL[p.kind];
  const status = p.kind === "claude" ? p.agentStatus : undefined;
  return (
    <div
      className={cn(
        "group flex shrink-0 items-center border-r text-xs",
        active ? "bg-background text-foreground" : "text-muted-foreground hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        onDoubleClick={onRename}
        onAuxClick={(e) => e.button === 1 && onClose?.()}
        title={onRename ? `${label} — double-click to rename` : label}
        className={cn("flex h-full max-w-48 items-center gap-1.5 pl-3 outline-none", onClose ? "pr-1" : "pr-3")}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        {(status === "working" || status === "starting") && (
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-label="working" />
        )}
        {status === "waiting" && <span className="size-1.5 shrink-0 rounded-full bg-warn" aria-label="needs you" />}
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={onClose}
          className={cn(
            "mr-1 rounded-sm p-0.5 hover:bg-accent hover:text-foreground",
            !active && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100",
          )}
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
}

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
