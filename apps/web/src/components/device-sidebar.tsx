import type { Project, Thread, ThreadKind } from "@everywhere/protocol";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  BugIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  HomeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SparklesIcon,
  SquareTerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useDevice } from "@/components/device-context";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { PresenceDot } from "@/components/presence-dot";
import { RenameDialog } from "@/components/rename-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDeviceOnline } from "@/lib/hub";
import { cn, errorMessage } from "@/lib/utils";

type Pending =
  | { kind: "rename-project"; project: Project }
  | { kind: "delete-project"; project: Project }
  | { kind: "rename-thread"; thread: Thread }
  | { kind: "delete-thread"; thread: Thread }
  | null;

function useCollapsed(deviceId: string) {
  const key = `ew:collapsed:${deviceId}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify([...collapsed]));
  }, [key, collapsed]);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return { collapsed, toggle };
}

export function DeviceSidebar({ className }: { className?: string }) {
  const { deviceId, device, peer, conn, info, projects, threads, debugOpen, setDebugOpen } = useDevice();
  const navigate = useNavigate();
  const { threadId: activeThreadId } = useParams({ strict: false });
  const { collapsed, toggle } = useCollapsed(deviceId);
  const [pending, setPending] = useState<Pending>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const connected = conn.state === "connected";
  const online = useDeviceOnline(deviceId);

  const threadsByProject = useMemo(() => {
    const m = new Map<string, Thread[]>();
    for (const t of threads.data ?? []) {
      const list = m.get(t.projectId) ?? [];
      list.push(t);
      m.set(t.projectId, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.createdAt - b.createdAt);
    return m;
  }, [threads.data]);

  const sortedProjects = useMemo(
    () =>
      [...(projects.data ?? [])].sort(
        (a, b) => Number(b.isHome) - Number(a.isHome) || a.name.localeCompare(b.name),
      ),
    [projects.data],
  );

  async function run(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function newThread(projectId: string, kind: ThreadKind) {
    await run(async () => {
      const t = await peer.call("threads.create", { projectId, kind });
      threads.refetch();
      if (collapsed.has(projectId)) toggle(projectId);
      await navigate({ to: "/d/$deviceId/t/$threadId", params: { deviceId, threadId: t.id } });
    });
  }

  return (
    <aside className={cn("flex min-h-0 flex-col border-r bg-sidebar", className)}>
      <div className="flex items-center gap-2.5 border-b px-3 py-2.5">
        <PresenceDot online={online} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{device?.name ?? info.data?.hostname ?? "Device"}</div>
          <div className="truncate text-xs text-muted-foreground">
            {connected
              ? info.data
                ? `${info.data.os}/${info.data.arch} · ${info.data.version}`
                : "Connected"
              : conn.state === "offline"
                ? "Offline"
                : conn.state === "failed"
                  ? "Unreachable"
                  : "Connecting…"}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(debugOpen && "bg-accent text-accent-foreground")}
          onClick={() => setDebugOpen(!debugOpen)}
          aria-pressed={debugOpen}
          aria-label="Connection debug"
          title="Connection debug"
        >
          <BugIcon />
        </Button>
      </div>

      <div className="flex h-8 shrink-0 items-center px-3 pt-1">
        <span className="text-xs font-medium text-muted-foreground">Projects</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          disabled={!connected}
          onClick={() => setNewProjectOpen(true)}
          aria-label="New project"
          title="New project"
        >
          <FolderPlusIcon />
        </Button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3" aria-label="Projects and threads">
        {(conn.state === "connecting" || conn.state === "idle") && !projects.data && <SidebarSkeleton />}
        {connected && projects.error && !projects.data && (
          <p className="px-2 py-1 text-xs text-destructive">{projects.error}</p>
        )}
        <ul className={cn("flex flex-col gap-px", !connected && "pointer-events-none opacity-50")}>
          {sortedProjects.map((p) => {
            const isCollapsed = collapsed.has(p.id);
            const list = threadsByProject.get(p.id) ?? [];
            return (
              <li key={p.id}>
                <div className="group flex h-7 items-center rounded-md pr-1 hover:bg-accent/60">
                  <button
                    type="button"
                    onClick={() => toggle(p.id)}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-1.5 text-left focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                    aria-expanded={!isCollapsed}
                    title={p.path}
                  >
                    <ChevronRightIcon
                      className={cn(
                        "size-3 shrink-0 text-muted-foreground transition-transform",
                        !isCollapsed && "rotate-90",
                      )}
                    />
                    {p.isHome ? (
                      <HomeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{p.name}</span>
                    {isCollapsed && list.length > 0 && (
                      <span className="text-xs text-muted-foreground tabular-nums">{list.length}</span>
                    )}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                        aria-label={`New thread in ${p.name}`}
                        title="New thread"
                      >
                        <PlusIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <NewThreadItems onPick={(kind) => newThread(p.id, kind)} />
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                        aria-label={`Actions for ${p.name}`}
                      >
                        <MoreHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <div className="max-w-64 truncate px-2 py-1 font-mono text-[11px] text-muted-foreground">
                        {p.path}
                      </div>
                      <DropdownMenuSeparator />
                      <NewThreadItems onPick={(kind) => newThread(p.id, kind)} />
                      {!p.isHome && (
                        <>
                          <DropdownMenuItem onSelect={() => setPending({ kind: "rename-project", project: p })}>
                            <PencilIcon />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setPending({ kind: "delete-project", project: p })}
                          >
                            <Trash2Icon />
                            Delete project
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {!isCollapsed && (
                  <ul className="flex flex-col gap-px pb-1">
                    {list.map((t) => (
                      <ThreadRow
                        key={t.id}
                        deviceId={deviceId}
                        thread={t}
                        active={t.id === activeThreadId}
                        onRename={() => setPending({ kind: "rename-thread", thread: t })}
                        onDelete={() => setPending({ kind: "delete-thread", thread: t })}
                      />
                    ))}
                    {list.length === 0 && (
                      <li className="flex gap-1 pl-6">
                        {(["terminal", "claude"] as const).map((kind) => (
                          <button
                            key={kind}
                            type="button"
                            onClick={() => newThread(p.id, kind)}
                            className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                          >
                            <PlusIcon className="size-3" />
                            {kind === "claude" ? "Claude" : "Terminal"}
                          </button>
                        ))}
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {actionError && (
        <div className="flex items-start gap-2 border-t bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          <span className="flex-1">{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss">
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}

      <NewProjectDialog
        peer={peer}
        home={info.data?.home}
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
        onCreated={(p) => {
          projects.refetch();
          if (collapsed.has(p.id)) toggle(p.id);
        }}
      />

      <RenameDialog
        open={pending?.kind === "rename-project" || pending?.kind === "rename-thread"}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.kind === "rename-project" ? "Rename project" : "Rename thread"}
        initial={
          pending?.kind === "rename-project"
            ? pending.project.name
            : pending?.kind === "rename-thread"
              ? pending.thread.name
              : ""
        }
        onSubmit={async (name) => {
          if (pending?.kind === "rename-project") {
            await peer.call("projects.rename", { id: pending.project.id, name });
            projects.refetch();
          } else if (pending?.kind === "rename-thread") {
            await peer.call("threads.rename", { id: pending.thread.id, name });
            threads.refetch();
          }
        }}
      />

      <ConfirmDialog
        open={pending?.kind === "delete-project" || pending?.kind === "delete-thread"}
        onOpenChange={(o) => !o && setPending(null)}
        title={
          pending?.kind === "delete-project"
            ? `Delete project ${pending.project.name}?`
            : pending?.kind === "delete-thread"
              ? `Delete thread ${pending.thread.name}?`
              : ""
        }
        confirmLabel="Delete"
        description={
          pending?.kind === "delete-project" ? (
            <p>
              Its threads are deleted and any running shells or Claude sessions in them are stopped. Files in{" "}
              <code className="font-mono text-xs text-foreground">{pending.project.path}</code> are not touched.
            </p>
          ) : (
            <p>
              {pending?.kind === "delete-thread" && pending.thread.kind === "claude"
                ? "Its conversation history in everywhere is deleted and Claude is stopped if it's running."
                : "If its shell is running, it's killed."}{" "}
              Anyone viewing it is disconnected.
            </p>
          )
        }
        onConfirm={async () => {
          if (pending?.kind === "delete-project") {
            const doomed = new Set((threadsByProject.get(pending.project.id) ?? []).map((t) => t.id));
            await peer.call("projects.delete", { id: pending.project.id });
            projects.refetch();
            threads.refetch();
            if (activeThreadId && doomed.has(activeThreadId)) {
              await navigate({ to: "/d/$deviceId", params: { deviceId } });
            }
          } else if (pending?.kind === "delete-thread") {
            const id = pending.thread.id;
            await peer.call("threads.delete", { id });
            threads.refetch();
            if (activeThreadId === id) await navigate({ to: "/d/$deviceId", params: { deviceId } });
          }
        }}
      />
    </aside>
  );
}

function ThreadRow({
  deviceId,
  thread: t,
  active,
  onRename,
  onDelete,
}: {
  deviceId: string;
  thread: Thread;
  active: boolean;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className={cn(
        "group flex h-7 items-center rounded-md pr-1",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
      )}
    >
      <Link
        to="/d/$deviceId/t/$threadId"
        params={{ deviceId, threadId: t.id }}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-7 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
      >
        {t.kind === "claude" ? (
          <SparklesIcon className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
        ) : (
          <SquareTerminalIcon className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
        )}
        <span className={cn("truncate", !active && "text-foreground/85")}>{t.name}</span>
        <ThreadStatusDot thread={t} />
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            aria-label={`Actions for ${t.name}`}
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={onRename}>
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2Icon />
            Delete thread
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function NewThreadItems({ onPick }: { onPick: (kind: ThreadKind) => void }) {
  return (
    <>
      <DropdownMenuItem onSelect={() => onPick("terminal")}>
        <SquareTerminalIcon />
        New terminal
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onPick("claude")}>
        <SparklesIcon />
        New Claude thread
      </DropdownMenuItem>
    </>
  );
}

/** Mint means live (shell or idle claude); claude threads also show what they're doing. */
function ThreadStatusDot({ thread: t }: { thread: Thread }) {
  const s = t.kind === "claude" ? t.agentStatus : undefined;
  if (s === "working" || s === "starting") {
    return <span className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-primary" title="Claude is working" />;
  }
  if (s === "waiting") {
    return <span className="ml-auto size-1.5 shrink-0 rounded-full bg-warn" title="Claude is waiting for you" />;
  }
  if (s === "error") {
    return <span className="ml-auto size-1.5 shrink-0 rounded-full bg-destructive" title="Claude stopped with an error" />;
  }
  if (!t.running) return null;
  return (
    <span
      className="ml-auto size-1.5 shrink-0 rounded-full bg-live"
      title={t.kind === "claude" ? "Claude running" : "Shell running"}
      aria-label="running"
    />
  );
}

function SidebarSkeleton() {
  return (
    <ul className="flex flex-col gap-2 px-2 py-1" aria-hidden>
      {[48, 32, 40].map((w) => (
        <li key={w} className="h-3 rounded bg-muted-foreground/10" style={{ width: `${w}%` }} />
      ))}
    </ul>
  );
}
