import type { CloneStatus, Project, Thread, ThreadKind } from "@everywhere/protocol";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDownUpIcon,
  BugIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  FolderPlusIcon,
  HomeIcon,
  LoaderIcon,
  MonitorDownIcon,
  LogOutIcon,
  MonitorIcon,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { auth, useAuth } from "@/lib/auth";
import { useDeviceOnline } from "@/lib/hub";
import { useInstallApp } from "@/lib/pwa";
import { getPrefs } from "@/lib/prefs";
import { useProjectIcon } from "@/lib/project-icons";
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

interface ThreadListRow {
  entry: Entry;
  project: Project;
  thread: Thread;
}

type SortBy = "name" | "recent" | "device";
type GroupBy = "project" | "device" | "none";

const COLLAPSED_KEY = "ew:collapsed";
const ARCHIVED_OPEN_KEY = "ew:archived-open";
const VIEW_KEY = "ew:sidebar-view";

/** How the sidebar sorts and groups projects and threads, remembered per browser. */
function useSidebarView() {
  const [view, setView] = useState<{ sort: SortBy; group: GroupBy }>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as { sort?: SortBy; group?: GroupBy };
      return { sort: v.sort ?? "name", group: v.group ?? "project" };
    } catch {
      return { sort: "name", group: "project" };
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      // Only a convenience.
    }
  }, [view]);
  return {
    ...view,
    setSort: (sort: SortBy) => setView((v) => ({ ...v, sort })),
    setGroup: (group: GroupBy) => setView((v) => ({ ...v, group })),
  };
}

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
/** When a thread was last used (a prompt sent, keys typed), or else created. */
const threadRecency = (t: Thread) => Math.max(t.lastOpenedAt ?? 0, t.createdAt);
/** A project is as recent as its most recent thread. */
const projectRecency = (r: ProjectRow) => Math.max(r.project.createdAt, ...r.threads.map(threadRecency));

/** Projects by name, each device's home folder after them. */
const byProjectName = (a: ProjectRow, b: ProjectRow) =>
  Number(a.project.isHome) - Number(b.project.isHome) || a.project.name.localeCompare(b.project.name);
const byDeviceName = (a: { entry: Entry }, b: { entry: Entry }) =>
  deviceName(a.entry).localeCompare(deviceName(b.entry)) || a.entry.deviceId.localeCompare(b.entry.deviceId);

function compareProjects(sort: SortBy) {
  return (a: ProjectRow, b: ProjectRow) =>
    sort === "recent"
      ? projectRecency(b) - projectRecency(a)
      : sort === "device"
        ? byDeviceName(a, b) || byProjectName(a, b)
        : byProjectName(a, b) || byDeviceName(a, b);
}

function compareThreads(sort: SortBy) {
  return (a: ThreadListRow, b: ThreadListRow) =>
    sort === "recent"
      ? threadRecency(b.thread) - threadRecency(a.thread)
      : (sort === "device" && byDeviceName(a, b)) ||
        a.project.name.localeCompare(b.project.name) ||
        byDeviceName(a, b) ||
        a.thread.createdAt - b.thread.createdAt;
}

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
  const view = useSidebarView();
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
    archived.sort((a, b) => (b.thread.archivedAt ?? 0) - (a.thread.archivedAt ?? 0));
    return { projects, archived };
  }, [list]);

  // What the list shows, per the sort and grouping picked in the header.
  const shown = useMemo(() => {
    const sorted = projects
      .map((r) =>
        view.sort === "recent"
          ? { ...r, threads: [...r.threads].sort((a, b) => threadRecency(b) - threadRecency(a)) }
          : r,
      )
      .sort(compareProjects(view.sort));
    if (view.group === "none") {
      const threads = sorted.flatMap(({ entry, project, threads }) =>
        threads.map((thread) => ({ entry, project, thread })),
      );
      return { group: "none" as const, threads: threads.sort(compareThreads(view.sort)) };
    }
    if (view.group === "device") {
      const devices = [...list]
        .map((entry) => {
          const rows = sorted.filter((r) => r.entry === entry);
          return { entry, rows, recent: Math.max(0, ...rows.map(projectRecency)) };
        })
        .filter((d) => d.rows.length > 0)
        .sort((a, b) => (view.sort === "recent" ? b.recent - a.recent : 0) || byDeviceName(a, b));
      return { group: "device" as const, devices };
    }
    return { group: "project" as const, projects: sorted };
  }, [projects, list, view.sort, view.group]);

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
      const mode = kind === "claude" ? (await getPrefs()).defaultPermissionMode : undefined;
      const t = await entry.peer.call("threads.create", { projectId, kind, ...(mode ? { permissionMode: mode } : {}) });
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

  const threadActions = (entry: Entry, t: Thread) => (
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
  );

  function renderProject({ entry, project: p, threads }: ProjectRow, showDevice: boolean) {
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
            <ProjectGlyph entry={entry} project={p} enabled={live && hasFeature(entry, "icons")} />
            <span className="truncate">{p.name}</span>
            <CloneBadge clone={entry.clones.data?.find((c) => c.projectId === p.id)} />
            {isCollapsed && threads.length > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">{threads.length}</span>
            )}
            {showDevice && (
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
                actions={threadActions(entry, t)}
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
  }

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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                "ml-auto",
                (view.sort !== "name" || view.group !== "project") && "text-primary hover:text-primary",
              )}
              aria-label="Sort and group"
              title="Sort and group"
            >
              <ArrowDownUpIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={view.sort} onValueChange={(v) => view.setSort(v as SortBy)}>
              <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="recent">Recent</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="device">Device</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Group by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={view.group} onValueChange={(v) => view.setGroup(v as GroupBy)}>
              <DropdownMenuRadioItem value="project">Project</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="device">Device</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="none">None</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {connectedEntries.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="New project" title="New project">
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
        {shown.group === "project" && (
          <ul className="flex flex-col gap-px">{shown.projects.map((r) => renderProject(r, multiDevice))}</ul>
        )}
        {shown.group === "device" &&
          shown.devices.map(({ entry, rows }) => {
            const key = `device:${entry.deviceId}`;
            const isCollapsed = collapsed.has(key);
            return (
              <div key={key} className="not-first:mt-2">
                <button
                  type="button"
                  onClick={() => toggle(key)}
                  className="flex h-7 w-full items-center gap-1.5 rounded-md pl-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none pointer-coarse:h-9"
                  aria-expanded={!isCollapsed}
                >
                  <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", !isCollapsed && "rotate-90")} />
                  <MonitorIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{deviceName(entry)}</span>
                  {isCollapsed && <span className="tabular-nums">{rows.length}</span>}
                </button>
                {!isCollapsed && <ul className="flex flex-col gap-px">{rows.map((r) => renderProject(r, false))}</ul>}
              </div>
            );
          })}
        {shown.group === "none" && (
          <ul className="flex flex-col gap-px">
            {shown.threads.map(({ entry, project, thread: t }) => (
              <ThreadRow
                key={`${entry.deviceId}/${t.id}`}
                deviceId={entry.deviceId}
                thread={t}
                active={isActive(entry, t)}
                flat
                dimmed={!connected(entry)}
                detail={[project.name, multiDevice ? deviceName(entry) : undefined].filter(Boolean).join(" · ")}
                actions={threadActions(entry, t)}
              />
            ))}
            {!loading && shown.threads.length === 0 && projects.length > 0 && (
              <li className="px-2 py-1 text-xs text-muted-foreground">No threads yet.</li>
            )}
          </ul>
        )}

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
          deviceId={newProjectFor.deviceId}
          home={newProjectFor.info.data?.home}
          canClone={hasFeature(newProjectFor, "clone")}
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
  const navigate = useNavigate();
  const live = conn.state === "connected";
  const hasDesktop = live && !!info.data?.features?.includes("desktop");
  const openDesktop = () => void navigate({ to: "/d/$deviceId/desktop", params: { deviceId: device.id } });
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
        {hasDesktop && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground pointer-coarse:size-8"
            aria-label={`Remote desktop of ${deviceName(entry)}`}
            title="Remote desktop"
            asChild
          >
            <Link
              to="/d/$deviceId/desktop"
              params={{ deviceId: device.id }}
              activeProps={{ className: "bg-accent text-accent-foreground" }}
            >
              <MonitorIcon />
            </Link>
          </Button>
        )}
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
            {hasDesktop && (
              <DropdownMenuItem onSelect={openDesktop}>
                <MonitorIcon />
                Remote desktop
              </DropdownMenuItem>
            )}
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
  flat,
  dimmed,
  actions,
}: {
  deviceId: string;
  thread: Thread;
  active: boolean;
  /** Shown under the name (archived threads: their project and device). */
  detail?: string;
  /** Not nested under a project, so not indented. */
  flat?: boolean;
  /** Its device isn't connected. */
  dimmed?: boolean;
  actions: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        "group flex items-center rounded-md pr-1",
        detail ? "min-h-7 py-0.5" : "h-7 pointer-coarse:h-10",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
        dimmed && "opacity-50",
      )}
    >
      <Link
        to="/d/$deviceId/t/$threadId"
        params={{ deviceId, threadId: t.id }}
        className={cn(
          "flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
          flat ? "pl-2" : "pl-7",
        )}
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

const CLONE_STAGES: Record<CloneStatus["stage"], string> = {
  connecting: "Connecting",
  counting: "Counting",
  receiving: "Downloading",
  resolving: "Resolving",
  checkout: "Checking out",
};

/** A clone into the project: its progress, or why it failed. */
function CloneBadge({ clone }: { clone: CloneStatus | undefined }) {
  if (!clone || clone.phase === "done") return null;
  if (clone.phase === "failed") {
    return (
      <span className="shrink-0 text-[11px] text-destructive" title={clone.error}>
        Clone failed
      </span>
    );
  }
  const pct = clone.percent >= 0 ? ` ${clone.percent}%` : "";
  return (
    <span
      className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground tabular-nums"
      title={`Cloning ${clone.url}${clone.detail ? ` — ${clone.detail}` : ""}`}
    >
      <LoaderIcon className="size-3 animate-spin" />
      {CLONE_STAGES[clone.stage]}
      {pct}
    </span>
  );
}

/** The project's favicon, or a folder (the home project: a house). */
function ProjectGlyph({ entry, project: p, enabled }: { entry: Entry; project: Project; enabled: boolean }) {
  const icon = useProjectIcon(entry.peer, entry.deviceId, p.id, enabled && !p.isHome);
  const [broken, setBroken] = useState<string | null>(null);
  if (icon && broken !== icon) {
    return (
      <img
        src={icon}
        alt=""
        className="size-3.5 shrink-0 rounded-[25%] object-contain"
        onError={() => setBroken(icon)}
      />
    );
  }
  const Icon = p.isHome ? HomeIcon : FolderIcon;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
}

/** Mint means live (shell or idle claude); claude threads also show what they're doing. */
export function ThreadStatusDot({ thread: t }: { thread: Thread }) {
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
  const installApp = useInstallApp();
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
          {installApp && (
            <DropdownMenuItem onSelect={installApp}>
              <MonitorDownIcon />
              Install app
            </DropdownMenuItem>
          )}
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
