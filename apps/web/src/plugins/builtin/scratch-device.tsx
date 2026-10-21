// The Scratch plugin's sections of a device's page: the composer that
// starts a Scratch thread, what Claude can do there, and the device's
// Scratch threads, with search across all its threads.

import type { SearchHit, Thread } from "@everywhere/protocol";
import { Link } from "@tanstack/react-router";
import { ArchiveIcon, HardDriveIcon, SearchIcon, ShieldIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { useDevice } from "@/components/device-context";
import { formatBytes, ScratchComposer, scratchThreads } from "@/components/scratch";
import { ThreadLine } from "@/components/thread-line";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRpc } from "@/lib/peer";
import { cn, timeAgo } from "@/lib/utils";
import type { DeviceProps } from "../types";

export function ScratchDevice({ entry }: DeviceProps) {
  const { deviceId, peer, info } = entry;
  const features = info.data?.features ?? [];
  const desktop = useRpc(peer, "desktop.info", {}, [], features.includes("desktop"));
  const usage = useRpc(peer, "scratch.usage", {}, ["threads.changed"]);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const scratch = scratchThreads(entry, showArchived);
  const archivedCount = scratchThreads(entry, true).length;
  return (
    <>
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
    </>
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
