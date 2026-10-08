import type { Project, SearchHit, Thread, ThreadKind } from "@everywhere/protocol";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  FolderIcon,
  FolderPlusIcon,
  HardDriveIcon,
  MonitorIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  SparklesIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ThreadStatusDot } from "@/components/app-sidebar";
import { CopyButton } from "@/components/copy-button";
import { useDevice } from "@/components/device-context";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { PresenceDot } from "@/components/presence-dot";
import {
  deviceName,
  formatBytes,
  homeProject,
  ScratchComposer,
  scratchProject,
  scratchThreads,
  threadRecency,
} from "@/components/scratch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDeviceOnline } from "@/lib/hub";
import { useRpc } from "@/lib/peer";
import { getPrefs } from "@/lib/prefs";
import { cn, errorMessage, timeAgo } from "@/lib/utils";

/** A device's page: Scratch first, then its other threads and projects. */
export const Route = createFileRoute("/_app/_workspace/d/$deviceId/")({
  component: DevicePage,
});

function DevicePage() {
  const entry = useDevice();
  const { deviceId, device, peer, info, projects, threads } = entry;
  const navigate = useNavigate();
  const features = info.data?.features ?? [];
  const online = useDeviceOnline(deviceId);
  const hasScratch = features.includes("scratch") && !!scratchProject(entry);
  const desktop = useRpc(peer, "desktop.info", {}, [], features.includes("desktop"));
  const usage = useRpc(peer, "scratch.usage", {}, ["threads.changed"], hasScratch);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [newProject, setNewProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = deviceName(entry);

  useEffect(() => {
    document.title = `${name} · everywhere`;
    return () => {
      document.title = "everywhere";
    };
  }, [name]);

  const scratch = scratchThreads(entry, showArchived);
  const home = homeProject(entry);
  const homeThreads = useMemo(
    () =>
      (threads.data ?? [])
        .filter((t) => t.projectId === home?.id && !t.archivedAt)
        .sort((a, b) => threadRecency(b) - threadRecency(a)),
    [threads.data, home?.id],
  );
  const otherProjects = (projects.data ?? []).filter((p) => !p.isHome && !p.isScratch);
  const archivedCount = scratchThreads(entry, true).length;

  async function newThread(project: Project, kind: ThreadKind) {
    setError(null);
    try {
      const mode = kind === "claude" ? (await getPrefs()).defaultPermissionMode : undefined;
      const t = await peer.call("threads.create", { projectId: project.id, kind, ...(mode ? { permissionMode: mode } : {}) });
      threads.refetch();
      await navigate({ to: "/d/$deviceId/t/$threadId", params: { deviceId, threadId: t.id } });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-2xl grid-cols-[minmax(0,1fr)] gap-6 px-4 pt-14 pb-10 md:pt-8">
        <header className="grid grid-cols-[minmax(0,1fr)] gap-1">
          <div className="flex items-center gap-2">
            <PresenceDot online={online} />
            <h1 className="truncate text-lg font-semibold">{name}</h1>
            {features.includes("desktop") && desktop.data?.enabled && desktop.data.available && (
              <Button variant="ghost" size="sm" className="ml-auto" asChild>
                <Link to="/d/$deviceId/desktop" params={{ deviceId }}>
                  <MonitorIcon />
                  Remote desktop
                </Link>
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {[info.data?.hostname !== device.name ? info.data?.hostname : undefined, info.data && `${info.data.os}/${info.data.arch}`, info.data?.version]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </header>

        {hasScratch ? (
          <section className="grid grid-cols-[minmax(0,1fr)] gap-3" aria-labelledby="scratch-heading">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
              <h2 id="scratch-heading" className="text-[13px] font-semibold">
                Scratch
              </h2>
              <p className="text-xs text-muted-foreground">
                For anything on this computer outside a project: diagnosing a problem, a quick task, some files. Each
                thread works in a fresh folder of its own, kept until you delete it.
              </p>
            </div>
            <ScratchComposer entries={[entry]} deviceId={deviceId} autoFocus />
            <Abilities os={info.data?.os} desktop={desktop.data} hasDesktopFeature={features.includes("desktop")} />
          </section>
        ) : (
          <section className="rounded-lg border p-3 text-xs text-muted-foreground">
            Scratch, for computer work outside a project, needs a newer daemon on {name}. Update it from the device list
            in the sidebar, or run <code className="font-mono text-foreground">everywhere update</code> there.
          </section>
        )}

        {hasScratch && (
          <section className="grid grid-cols-[minmax(0,1fr)] gap-2" aria-labelledby="scratch-threads-heading">
            <div className="flex items-center gap-2">
              <h2 id="scratch-threads-heading" className="text-[13px] font-semibold">
                {showArchived ? "Archived Scratch threads" : "Scratch threads"}
              </h2>
              {(archivedCount > 0 || showArchived) && (
                <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={() => setShowArchived((a) => !a)}>
                  <ArchiveIcon />
                  {showArchived ? "Back" : `Archived (${archivedCount})`}
                </Button>
              )}
            </div>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search threads on this device"
                className="pl-8"
                aria-label="Search threads on this device"
              />
            </div>
            {query.trim() ? (
              <SearchResults query={query} />
            ) : scratch.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">
                {showArchived ? "No archived Scratch threads." : "No Scratch threads yet. Start one above."}
              </p>
            ) : (
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-px">
                {scratch.map((t) => (
                  <ThreadLine key={t.id} deviceId={deviceId} thread={t} detail={folderDetail(t, usage.data?.folders)} />
                ))}
              </ul>
            )}
            {usage.data && (
              <div className="flex min-w-0 items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                <HardDriveIcon className="size-3 shrink-0" />
                <span className="shrink-0">
                  {usage.data.files} file{usage.data.files === 1 ? "" : "s"}, {formatBytes(usage.data.bytes)}
                  {usage.data.truncated ? "+" : ""} in
                </span>
                <code className="truncate font-mono" title={usage.data.root}>
                  {usage.data.root}
                </code>
                <CopyButton text={usage.data.root} label="Copy" />
              </div>
            )}
          </section>
        )}

        {home && (
          <section className="grid grid-cols-[minmax(0,1fr)] gap-2" aria-labelledby="home-heading">
            <div className="flex items-center gap-2">
              <h2 id="home-heading" className="text-[13px] font-semibold">
                Home
              </h2>
              <code className="truncate font-mono text-[11px] text-muted-foreground">{home.path}</code>
              <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={() => void newThread(home, "terminal")}>
                <SquareTerminalIcon />
                Terminal in ~
              </Button>
            </div>
            {homeThreads.length > 0 && (
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-px">
                {homeThreads.map((t) => (
                  <ThreadLine key={t.id} deviceId={deviceId} thread={t} />
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="grid grid-cols-[minmax(0,1fr)] gap-2" aria-labelledby="projects-heading">
          <div className="flex items-center gap-2">
            <h2 id="projects-heading" className="text-[13px] font-semibold">
              Projects on {name}
            </h2>
            <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={() => setNewProject(true)}>
              <FolderPlusIcon />
              New project
            </Button>
          </div>
          {otherProjects.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">No projects yet.</p>
          ) : (
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-px">
              {otherProjects.map((p) => (
                <ProjectLine
                  key={p.id}
                  project={p}
                  threads={(threads.data ?? []).filter((t) => t.projectId === p.id && !t.archivedAt).length}
                  claude={features.includes("claude")}
                  onNew={(kind) => void newThread(p, kind)}
                />
              ))}
            </ul>
          )}
        </section>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      {newProject && (
        <NewProjectDialog
          peer={peer}
          deviceId={deviceId}
          home={info.data?.home}
          canClone={features.includes("clone")}
          canMkdir={features.includes("mkdir")}
          open
          onOpenChange={(o) => !o && setNewProject(false)}
          onCreated={() => projects.refetch()}
        />
      )}
    </div>
  );
}

/** What Claude can and can't do here, so nothing about it is a surprise. */
function Abilities({
  os,
  desktop,
  hasDesktopFeature,
}: {
  os: string | undefined;
  desktop: { enabled: boolean; available: boolean; reason?: string } | undefined;
  hasDesktopFeature: boolean;
}) {
  const screen = !hasDesktopFeature
    ? "can't see the screen on this OS"
    : !desktop
      ? undefined
      : desktop.enabled && desktop.available
        ? os === "windows"
          ? "can see and use your screen"
          : "can see and use the screen"
        : desktop.enabled
          ? `can't see the screen now${desktop.reason ? ` (${desktop.reason})` : ""}`
          : "can't see the screen (run `everywhere desktop enable` on the device to allow it)";
  return (
    <div className="flex items-start gap-2 rounded-md bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
      <ShieldIcon className="mt-0.5 size-3.5 shrink-0" />
      <p>
        Claude starts in <span className="text-foreground">Auto</span>, runs commands as your user and has no root: when
        something needs sudo, it shows the command for you to run in a terminal.
        {screen && <> It {screen}.</>}
      </p>
    </div>
  );
}

function folderDetail(t: Thread, folders: Record<string, { files: number; bytes: number }> | undefined) {
  const f = t.scratchDir ? folders?.[t.scratchDir] : undefined;
  if (!f || f.files === 0) return undefined;
  return `${f.files} file${f.files === 1 ? "" : "s"}, ${formatBytes(f.bytes)}`;
}

function ThreadLine({ deviceId, thread: t, detail }: { deviceId: string; thread: Thread; detail?: string }) {
  const Icon = t.kind === "claude" ? SparklesIcon : SquareTerminalIcon;
  return (
    <li>
      <Link
        to="/d/$deviceId/t/$threadId"
        params={{ deviceId, threadId: t.id }}
        className="flex h-9 items-center gap-2 rounded-md px-2 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{t.name}</span>
        <ThreadStatusDot thread={t} />
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
          {detail && <span>{detail}</span>}
          <span>{timeAgo(threadRecency(t))}</span>
        </span>
      </Link>
    </li>
  );
}

function ProjectLine({
  project: p,
  threads,
  claude,
  onNew,
}: {
  project: Project;
  threads: number;
  claude: boolean;
  onNew: (kind: ThreadKind) => void;
}) {
  return (
    <li className="group flex h-9 items-center gap-2 rounded-md px-2 hover:bg-accent/60">
      <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-[50%] shrink-0 truncate">{p.name}</span>
      <code className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground sm:block">{p.path}</code>
      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {threads} thread{threads === 1 ? "" : "s"}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => onNew("terminal")}
        aria-label={`New terminal in ${p.name}`}
        title="New terminal"
      >
        <SquareTerminalIcon />
      </Button>
      {claude && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onNew("claude")}
          aria-label={`New Claude thread in ${p.name}`}
          title="New Claude thread"
        >
          <PlusIcon />
        </Button>
      )}
    </li>
  );
}

/** Threads on the device whose name or messages match, with their project. */
function SearchResults({ query }: { query: string }) {
  const { deviceId, peer, threads, projects } = useDevice();
  const [debounced, setDebounced] = useState(query.trim());
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);
  const hits = useRpc(peer, "threads.search", { query: debounced, limit: 20 }, [], !!debounced);
  const rows = (hits.data ?? [])
    .map((h: SearchHit) => ({ hit: h, thread: threads.data?.find((t) => t.id === h.threadId) }))
    .filter((r): r is { hit: SearchHit; thread: Thread } => !!r.thread);
  if (hits.error) return <p className="px-1 text-xs text-destructive">{hits.error}</p>;
  if (!hits.data) return <p className="px-1 py-2 text-xs text-muted-foreground">Searching…</p>;
  if (rows.length === 0) return <p className="px-1 py-2 text-xs text-muted-foreground">No matches.</p>;
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)] gap-px">
      {rows.map(({ hit, thread: t }) => {
        const project = projects.data?.find((p) => p.id === t.projectId);
        return (
          <li key={t.id}>
            <Link
              to="/d/$deviceId/t/$threadId"
              params={{ deviceId, threadId: t.id }}
              className="grid grid-cols-[minmax(0,1fr)] gap-0.5 rounded-md px-2 py-1.5 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{t.name}</span>
                <span className={cn("shrink-0 text-[11px] text-muted-foreground", t.archivedAt && "italic")}>
                  {project?.isScratch ? "Scratch" : project?.isHome ? "Home" : project?.name}
                  {t.archivedAt ? " · archived" : ""}
                </span>
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{timeAgo(hit.at)}</span>
              </span>
              {hit.snippet && <span className="line-clamp-2 text-xs text-muted-foreground">{hit.snippet}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
