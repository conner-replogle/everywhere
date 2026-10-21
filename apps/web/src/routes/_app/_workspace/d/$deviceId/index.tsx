import type { Project, ThreadKind } from "@everywhere/protocol";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FolderIcon, FolderPlusIcon, PlusIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useDevice } from "@/components/device-context";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { PresenceDot } from "@/components/presence-dot";
import { deviceName, homeProject, threadRecency } from "@/components/scratch";
import { ThreadLine } from "@/components/thread-line";
import { Button } from "@/components/ui/button";
import { useDeviceOnline } from "@/lib/hub";
import { getPrefs } from "@/lib/prefs";
import { errorMessage } from "@/lib/utils";
import { devicePlugins } from "@/plugins/registry";

/** A device's page: what plugins put there (Scratch), then its home and projects. */
export const Route = createFileRoute("/_app/_workspace/d/$deviceId/")({
  component: DevicePage,
});

function DevicePage() {
  const entry = useDevice();
  const { deviceId, device, peer, info, projects, threads } = entry;
  const navigate = useNavigate();
  const features = info.data?.features ?? [];
  const online = useDeviceOnline(deviceId);
  const plugins = useMemo(() => devicePlugins(info.data), [info.data]);
  const [newProject, setNewProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = deviceName(entry);

  useEffect(() => {
    document.title = `${name} · everywhere`;
    return () => {
      document.title = "everywhere";
    };
  }, [name]);

  const home = homeProject(entry);
  const homeThreads = useMemo(
    () =>
      (threads.data ?? [])
        .filter((t) => t.projectId === home?.id && !t.archivedAt)
        .sort((a, b) => threadRecency(b) - threadRecency(a)),
    [threads.data, home?.id],
  );
  const otherProjects = (projects.data ?? []).filter((p) => !p.isHome && !p.isScratch);

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
            {plugins.flatMap((p) => (p.device?.header ?? []).map((Item, i) => <Item key={`${p.id}:${i}`} entry={entry} />))}
          </div>
          <p className="text-xs text-muted-foreground">
            {[info.data?.hostname !== device.name ? info.data?.hostname : undefined, info.data && `${info.data.os}/${info.data.arch}`, info.data?.version]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </header>

        {plugins.flatMap((p) => p.device?.sections ?? [])
          .sort((x, y) => x.order - y.order)
          .map(({ component: Section }, i) => (
            <Section key={i} entry={entry} />
          ))}

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
