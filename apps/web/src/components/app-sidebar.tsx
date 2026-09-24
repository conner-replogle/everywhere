import type { Project, Thread, ThreadKind } from "@everywhere/protocol";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BugIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  FolderPlusIcon,
  HomeIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SettingsIcon,
  SparklesIcon,
  SquareTerminalIcon,
  Trash2Icon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DeviceContext, type DeviceContextValue, useDevice } from "@/components/device-context";
import { DeviceUpdate, RefreshVersionButton, useUpdateCheck } from "@/components/device-update";
import { useFleet } from "@/components/fleet";
import { HubStatus } from "@/components/hub-status";
import { Logo } from "@/components/logo";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { PresenceDot } from "@/components/presence-dot";
import { RenameDialog } from "@/components/rename-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { auth, useAuth } from "@/lib/auth";
import { useDeviceOnline } from "@/lib/hub";
import { cn, errorMessage } from "@/lib/utils";

type Entry = DeviceContextValue;

type Pending =
  | { kind: "rename-project"; entry: Entry; project: Project }
  | { kind: "delete-project"; entry: Entry; project: Project }
  | { kind: "rename-thread"; entry: Entry; thread: Thread }
  | { kind: "delete-thread"; entry: Entry; thread: Thread }
  | null;

interface ProjectRow {
  entry: Entry;
  project: Project;
  threads: Thread[];
}

interface ArchivedRow {
  entry: Entry;
  thread: Thread;
  project: Project | undefined;
}

const COLLAPSED_KEY = "ew:collapsed";
const ARCHIVED_OPEN_KEY = "ew:archived-open";

function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {
      // Only a convenience.
    }
  }, [collapsed]);
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return { collapsed, toggle };
}

const projectKey = (deviceId: string, projectId: string) => `${deviceId}/${projectId}`;
const connected = (e: Entry) => e.conn.state === "connected";
const hasFeature = (e: Entry, f: string) => e.info.data?.features?.includes(f as never) ?? false;
const deviceName = (e: Entry) => e.device.name || e.info.data?.hostname || "Device";

export function AppSidebar({
  className,
  debugDevice,
  onDebug,
}: {
  className?: string;
  debugDevice: string | null;
  onDebug: (deviceId: string) => void;
}) {
  const { devices, entries } = useFleet();
  const navigate = useNavigate();
  const { deviceId: activeDeviceId, threadId: activeThreadId } = useParams({ strict: false });
  const { collapsed, toggle } = useCollapsed();
  const [archivedOpen, setArchivedOpen] = useState(() => localStorage.getItem(ARCHIVED_OPEN_KEY) === "1");
  const [pending, setPending] = useState<Pending>(null);
  // Deleting a claude thread that has a worktree: also remove the worktree?
  const [removeWorktree, setRemoveWorktree] = useState(true);
  const [newProjectFor, setNewProjectFor] = useState<Entry | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const list = useMemo(() => [...entries.values()], [entries]);
  const multiDevice = (devices?.length ?? 0) > 1;

  const { projects, archived } = useMemo(() => {
    const projects: ProjectRow[] = [];
    const archived: ArchivedRow[] = [];
    for (const entry of list) {
      const byProject = new Map<string, Thread[]>();
      for (const t of entry.threads.data ?? []) {
        if (t.archivedAt) {
          archived.push({ entry, thread: t, project: entry.projects.data?.find((p) => p.id === t.projectId) });
          continue;
        }
        const ts = byProject.get(t.projectId) ?? [];
        ts.push(t);
        byProject.set(t.projectId, ts);
      }
      for (const project of entry.projects.data ?? []) {
        const threads = (byProject.get(project.id) ?? []).sort((a, b) => a.createdAt - b.createdAt);
        projects.push({ entry, project, threads });
      }
    }
    // Projects by name, each device's home folder after them.
    projects.sort(
      (a, b) =>
        Number(a.project.isHome) - Number(b.project.isHome) ||
        a.project.name.localeCompare(b.project.name) ||
        deviceName(a.entry).localeCompare(deviceName(b.entry)),
    );
    archived.sort((a, b) => (b.thread.archivedAt ?? 0) - (a.thread.archivedAt ?? 0));
    return { projects, archived };
  }, [list]);

  const connectedEntries = list.filter(connected);
  const loading = devices === undefined || list.some((e) => e.conn.state === "connecting" && !e.projects.data);

  async function run(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function newThread(entry: Entry, projectId: string, kind: ThreadKind) {
    await run(async () => {
      const t = await entry.peer.call("threads.create", { projectId, kind });
      entry.threads.refetch();
      const key = projectKey(entry.deviceId, projectId);
      if (collapsed.has(key)) toggle(key);
      await navigate({ to: "/d/$deviceId/t/$threadId", params: { deviceId: entry.deviceId, threadId: t.id } });
    });
  }

  async function setArchived(entry: Entry, thread: Thread, archived: boolean) {
    await run(async () => {
      await entry.peer.call("threads.archive", { id: thread.id, archived });
      entry.threads.refetch();
    });
  }

  const isActive = (entry: Entry, t: Thread) => entry.deviceId === activeDeviceId && t.id === activeThreadId;

  return (
    <aside className={cn("flex min-h-0 flex-col border-r bg-sidebar", className)}>
      <div className="flex h-10 shrink-0 items-center gap-3 border-b px-3">
        <Link
          to="/"
          className="shrink-0 rounded-sm focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        >
          <Logo className="text-[13px]" />
        </Link>
        <span className="ml-auto min-w-0">
          <HubStatus />
        </span>
      </div>
      <div className="flex h-9 shrink-0 items-center pr-1.5 pl-3">
        <span className="text-xs font-medium text-muted-foreground">Projects</span>
        {connectedEntries.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="New project" title="New project">
                <FolderPlusIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>New project on</DropdownMenuLabel>
              {connectedEntries.map((e) => (
                <DropdownMenuItem key={e.deviceId} onSelect={() => setNewProjectFor(e)}>
                  {deviceName(e)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            disabled={connectedEntries.length === 0}
            onClick={() => setNewProjectFor(connectedEntries[0] ?? null)}
            aria-label="New project"
            title="New project"
          >
            <FolderPlusIcon />
          </Button>
        )}
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5" aria-label="Projects and threads">
        {loading && projects.length === 0 && <SidebarSkeleton />}
        {!loading && projects.length === 0 && devices && devices.length > 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {connectedEntries.length === 0 ? "No device is connected." : "No projects yet."}
          </p>
        )}
        <ul className="flex flex-col gap-px">
          {projects.map(({ entry, project: p, threads }) => {
            const key = projectKey(entry.deviceId, p.id);
            const isCollapsed = collapsed.has(key);
            const live = connected(entry);
            const claude = hasFeature(entry, "claude");
            return (
              <li key={key} className={cn(!live && "opacity-50")}>
                <div className="group flex h-7 items-center rounded-md pr-1 hover:bg-accent/60 pointer-coarse:h-10">
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-1.5 text-left focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                    aria-expanded={!isCollapsed}
                    title={`${p.path} on ${deviceName(entry)}`}
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
                    {isCollapsed && threads.length > 0 && (
                      <span className="text-xs text-muted-foreground tabular-nums">{threads.length}</span>
                    )}
                    {multiDevice && (
                      <span className="ml-auto max-w-[45%] shrink-0 truncate pl-1 text-[11px] text-muted-foreground pointer-fine:group-hover:hidden pointer-fine:group-has-data-[state=open]:hidden">
                        {deviceName(entry)}
                      </span>
                    )}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!live}
                        className="hidden group-hover:inline-flex focus-visible:inline-flex data-[state=open]:inline-flex pointer-coarse:inline-flex pointer-coarse:size-8"
                        aria-label={`New thread in ${p.name}`}
                        title="New thread"
                      >
                        <PlusIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <NewThreadItems claude={claude} onPick={(kind) => newThread(entry, p.id, kind)} />
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!live}
                        className="hidden group-hover:inline-flex focus-visible:inline-flex data-[state=open]:inline-flex pointer-coarse:inline-flex pointer-coarse:size-8"
                        aria-label={`Actions for ${p.name}`}
                      >
                        <MoreHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <div className="max-w-64 truncate px-2 py-1 font-mono text-[11px] text-muted-foreground">
                        {deviceName(entry)}:{p.path}
                      </div>
                      <DropdownMenuSeparator />
                      <NewThreadItems claude={claude} onPick={(kind) => newThread(entry, p.id, kind)} />
                      {!p.isHome && (
                        <>
                          <DropdownMenuItem onSelect={() => setPending({ kind: "rename-project", entry, project: p })}>
                            <PencilIcon />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setPending({ kind: "delete-project", entry, project: p })}
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
                    {threads.map((t) => (
                      <ThreadRow
                        key={t.id}
                        deviceId={entry.deviceId}
                        thread={t}
                        active={isActive(entry, t)}
                        actions={
                          <>
                            <DropdownMenuItem onSelect={() => setPending({ kind: "rename-thread", entry, thread: t })}>
                              <PencilIcon />
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {hasFeature(entry, "archive") ? (
                              <DropdownMenuItem onSelect={() => setArchived(entry, t, true)}>
                                <ArchiveIcon />
                                Archive
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => {
                                  setRemoveWorktree(true);
                                  setPending({ kind: "delete-thread", entry, thread: t });
                                }}
                              >
                                <Trash2Icon />
                                Delete thread
                              </DropdownMenuItem>
                            )}
                          </>
                        }
                      />
                    ))}
                    {threads.length === 0 && live && (
                      <li className="flex gap-1 pl-6">
                        {(claude ? (["terminal", "claude"] as const) : (["terminal"] as const)).map((kind) => (
                          <button
                            key={kind}
                            type="button"
                            onClick={() => newThread(entry, p.id, kind)}
                            className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground pointer-coarse:h-9 pointer-coarse:px-2.5"
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

        {archived.length > 0 && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => {
                const open = !archivedOpen;
                setArchivedOpen(open);
                try {
                  localStorage.setItem(ARCHIVED_OPEN_KEY, open ? "1" : "0");
                } catch {
                  // Only a convenience.
                }
              }}
              className="flex h-7 w-full items-center gap-1.5 rounded-md pl-1.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
              aria-expanded={archivedOpen}
            >
              <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", archivedOpen && "rotate-90")} />
              <ArchiveIcon className="size-3.5 shrink-0" />
              Archived
              <span className="tabular-nums">{archived.length}</span>
            </button>
            {archivedOpen && (
              <ul className="flex flex-col gap-px">
                {archived.map(({ entry, thread: t, project }) => (
                  <ThreadRow
                    key={`${entry.deviceId}/${t.id}`}
                    deviceId={entry.deviceId}
                    thread={t}
                    active={isActive(entry, t)}
                    detail={[project?.name, multiDevice ? deviceName(entry) : undefined].filter(Boolean).join(" · ")}
                    actions={
                      <>
                        <DropdownMenuItem disabled={!connected(entry)} onSelect={() => setArchived(entry, t, false)}>
                          <ArchiveRestoreIcon />
                          Restore
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={!connected(entry)}
                          onSelect={() => {
                            setRemoveWorktree(true);
                            setPending({ kind: "delete-thread", entry, thread: t });
                          }}
                        >
                          <Trash2Icon />
                          Delete forever
                        </DropdownMenuItem>
                      </>
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </nav>

      {actionError && (
        <div className="flex items-start gap-2 border-t bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          <span className="flex-1">{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss">
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}

      {list.length > 0 && (
        <div className="max-h-[40%] shrink-0 overflow-y-auto border-t py-1">
          <div className="px-3 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">Devices</div>
          {list.map((entry) => (
            <DeviceContext.Provider key={entry.deviceId} value={entry}>
              <DeviceRow
                debugging={debugDevice === entry.deviceId}
                onDebug={() => onDebug(entry.deviceId)}
                onNewProject={() => setNewProjectFor(entry)}
              />
            </DeviceContext.Provider>
          ))}
        </div>
      )}

      <SidebarFooter />

      {newProjectFor && (
        <NewProjectDialog
          peer={newProjectFor.peer}
          home={newProjectFor.info.data?.home}
          open
          onOpenChange={(o) => !o && setNewProjectFor(null)}
          onCreated={(p) => {
            newProjectFor.projects.refetch();
            const key = projectKey(newProjectFor.deviceId, p.id);
            if (collapsed.has(key)) toggle(key);
          }}
        />
      )}

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
            await pending.entry.peer.call("projects.rename", { id: pending.project.id, name });
            pending.entry.projects.refetch();
          } else if (pending?.kind === "rename-thread") {
            await pending.entry.peer.call("threads.rename", { id: pending.thread.id, name });
            pending.entry.threads.refetch();
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
              Its threads, archived ones included, are deleted and any running shells or Claude sessions in them are
              stopped. Files in <code className="font-mono text-xs text-foreground">{pending.project.path}</code> on{" "}
              {deviceName(pending.entry)} are not touched.
            </p>
          ) : (
            <>
              <p>
                {pending?.kind === "delete-thread" && pending.thread.kind === "claude"
                  ? "Its conversation history in everywhere is deleted and Claude is stopped if it's running."
                  : "If its shell is running, it's killed."}{" "}
                This can't be undone.
              </p>
              {pending?.kind === "delete-thread" && pending.thread.worktree && (
                <label className="flex items-start gap-2 text-foreground">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={removeWorktree}
                    onChange={(e) => setRemoveWorktree(e.target.checked)}
                  />
                  <span>
                    Also delete its worktree, including uncommitted changes. The branch is kept.
                    <code className="mt-0.5 block font-mono text-xs break-all text-muted-foreground">
                      {pending.thread.worktree}
                    </code>
                  </span>
                </label>
              )}
            </>
          )
        }
        onConfirm={async () => {
          if (pending?.kind === "delete-project") {
            const { entry, project } = pending;
            await entry.peer.call("projects.delete", { id: project.id });
            entry.projects.refetch();
            entry.threads.refetch();
            const doomed = entry.threads.data?.some((t) => t.projectId === project.id && isActive(entry, t));
            if (doomed) await navigate({ to: "/" });
          } else if (pending?.kind === "delete-thread") {
            const { entry, thread } = pending;
            await entry.peer.call("threads.delete", { id: thread.id, keepWorktree: !removeWorktree });
            entry.threads.refetch();
            if (isActive(entry, thread)) await navigate({ to: "/" });
          }
        }}
      />
    </aside>
  );
}

/** A device in the sidebar footer: its state, updates, and what's done per device. */
function DeviceRow({
  debugging,
  onDebug,
  onNewProject,
}: {
  debugging: boolean;
  onDebug: () => void;
  onNewProject: () => void;
}) {
  const entry = useDevice();
  const { device, conn, info, peer } = entry;
  const online = useDeviceOnline(device.id);
  const update = useUpdateCheck();
  const live = conn.state === "connected";
  const status = live
    ? info.data
      ? `${info.data.os}/${info.data.arch} · ${info.data.version}`
      : "Connected"
    : conn.state === "offline"
      ? "Offline"
      : conn.state === "failed"
        ? "Unreachable"
        : "Connecting…";

  return (
    <div>
      <div className="group flex h-8 items-center gap-2 rounded-md pr-1.5 pl-3 hover:bg-accent/40">
        <PresenceDot online={online} />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate">{deviceName(entry)}</span>
          <span className={cn("truncate text-[11px] text-muted-foreground", conn.state === "failed" && "text-warn")}>
            {status}
          </span>
        </div>
        {live && info.data && <RefreshVersionButton update={update} />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100",
                debugging && "opacity-100",
              )}
              aria-label={`Actions for ${deviceName(entry)}`}
            >
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top">
            <DropdownMenuItem disabled={!live} onSelect={onNewProject}>
              <FolderPlusIcon />
              New project…
            </DropdownMenuItem>
            {conn.state === "failed" && (
              <DropdownMenuItem onSelect={() => peer.retry()}>
                <RotateCcwIcon />
                Try connecting again
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onDebug}>
              <BugIcon />
              {debugging ? "Hide connection debug" : "Connection debug"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <DeviceUpdate update={update} />
    </div>
  );
}

function ThreadRow({
  deviceId,
  thread: t,
  active,
  detail,
  actions,
}: {
  deviceId: string;
  thread: Thread;
  active: boolean;
  /** Shown under the name (archived threads: their project and device). */
  detail?: string;
  actions: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        "group flex items-center rounded-md pr-1",
        detail ? "min-h-7 py-0.5" : "h-7 pointer-coarse:h-10",
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
        <span className="grid min-w-0">
          <span className={cn("truncate", !active && "text-foreground/85")}>{t.name}</span>
          {detail && <span className="truncate text-[11px] text-muted-foreground">{detail}</span>}
        </span>
        <ThreadStatusDot thread={t} />
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:size-8 pointer-coarse:opacity-100"
            aria-label={`Actions for ${t.name}`}
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">{actions}</DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function NewThreadItems({ claude, onPick }: { claude: boolean; onPick: (kind: ThreadKind) => void }) {
  return (
    <>
      <DropdownMenuItem onSelect={() => onPick("terminal")}>
        <SquareTerminalIcon />
        New terminal
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!claude}
        onSelect={() => onPick("claude")}
        title={claude ? undefined : "Update the daemon to use Claude threads (run `everywhere update` on the device)"}
      >
        <SparklesIcon />
        {claude ? "New Claude thread" : "Claude needs a daemon update"}
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

/** Settings and the signed-in account, at the bottom of the sidebar. */
function SidebarFooter() {
  const navigate = useNavigate();
  const user = useAuth()?.user;
  return (
    <div className="flex shrink-0 items-center gap-1 border-t px-1.5 py-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start text-foreground">
            <UserIcon className="text-muted-foreground" />
            <span className="truncate">{user?.username ?? "Account"}</span>
            <ChevronsUpDownIcon className="ml-auto text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-56">
          <DropdownMenuLabel>Signed in as {user?.username}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={async () => {
              await auth.logout();
              await navigate({ to: "/login" });
            }}
          >
            <LogOutIcon />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="sm" className="shrink-0" asChild>
        <Link to="/settings" activeProps={{ className: "bg-accent text-accent-foreground" }}>
          <SettingsIcon />
          Settings
        </Link>
      </Button>
    </div>
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
