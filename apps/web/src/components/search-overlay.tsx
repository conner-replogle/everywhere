// Search every thread on every device, from anywhere: a full-screen overlay
// on a shortcut the user picks (Settings → Appearance), or the sidebar's
// search button. Each daemon searches its own threads (names, prompts,
// replies and tool calls; see threads.search) and the results are merged,
// best first. With nothing typed it lists recent threads, as a switcher.

import type { Thread } from "@everywhere/protocol";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  CircleCheckIcon,
  LoaderIcon,
  MessageSquareIcon,
  PinIcon,
  SearchIcon,
  SparklesIcon,
  TagIcon,
  WrenchIcon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useFleet } from "@/components/fleet";
import { KindIcon } from "@/components/kind-icon";
import { deviceName } from "@/components/scratch";
import { completeHit, highlight, mergeResults, type Result, searchNames, searchTerms } from "@/lib/search";
import { formatShortcut, matches, parseShortcut, useSearchShortcut } from "@/lib/shortcut";
import { useDebounced } from "@/lib/telemetry";
import { cn, errorMessage, timeAgo } from "@/lib/utils";

const OpenSearch = createContext<() => void>(() => {});

/** Opens the search overlay (for buttons that offer it). */
export const useOpenSearch = () => useContext(OpenSearch);

/** Mounts the overlay and its shortcut for everything under it. */
export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const shortcut = useSearchShortcut();
  useEffect(() => {
    const chord = parseShortcut(shortcut);
    if (!chord) return;
    // Capture, so a terminal, a remote desktop or a web view can't keep it.
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !matches(e, chord)) return;
      // Recording a new shortcut: the keys are for the recorder.
      if (document.activeElement?.closest("[data-shortcut-recorder]")) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [shortcut]);
  const show = useCallback(() => setOpen(true), []);
  return (
    <OpenSearch.Provider value={show}>
      {children}
      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        {open && <SearchOverlay onClose={() => setOpen(false)} />}
      </DialogPrimitive.Root>
    </OpenSearch.Provider>
  );
}

type Status = { state: "searching" } | { state: "done" } | { state: "offline" } | { state: "error"; message: string };

const LIMIT = 40;
const RECENT = 30;

function SearchOverlay({ onClose }: { onClose: () => void }) {
  const { entries } = useFleet();
  const navigate = useNavigate();
  const shortcut = useSearchShortcut();
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(true);
  const [device, setDevice] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const listRef = useRef<HTMLUListElement>(null);
  const debounced = useDebounced(query.trim(), 120);
  const terms = useMemo(() => searchTerms(debounced), [debounced]);

  const all = useMemo(() => [...entries.values()], [entries]);
  const devices = useMemo(() => (device ? all.filter((e) => e.deviceId === device) : all), [all, device]);
  // Each device's threads, as a key that only changes when they do (not on every render).
  const threadsKey = all.map((e) => `${e.deviceId}:${e.conn.state}:${e.threads.data?.length ?? -1}`).join(",");

  useEffect(() => {
    if (!debounced) {
      setResults([]);
      setStatus({});
      return;
    }
    let stale = false;
    const now = Date.now();
    const found: Record<string, Result[]> = {};
    const publish = () => {
      if (!stale) setResults(mergeResults(Object.values(found).flat()));
    };
    const report = (id: string, s: Status) => !stale && setStatus((prev) => ({ ...prev, [id]: s }));
    setStatus({});
    setResults([]);
    for (const e of devices) {
      const threads = e.threads.data;
      const add = (hits: Result["hit"][]) => {
        found[e.deviceId] = hits.filter((h) => archived || !h.archivedAt).map((hit) => ({ deviceId: e.deviceId, hit }));
        publish();
      };
      if (e.conn.state !== "connected") {
        report(e.deviceId, { state: "offline" });
        continue;
      }
      const features = e.info.data?.features ?? [];
      if (!features.includes("search") && !features.includes("scratch")) {
        add(searchNames(threads ?? [], debounced, now).flatMap((h) => completeHit(h, threads, now) ?? []));
        report(e.deviceId, { state: "done" });
        continue;
      }
      report(e.deviceId, { state: "searching" });
      e.peer
        .call("threads.search", {
          query: debounced,
          limit: LIMIT,
          ...(features.includes("search") ? { includeArchived: archived } : {}),
        })
        .then((hits) => {
          add(hits.flatMap((h) => completeHit(h, threads, now) ?? []));
          report(e.deviceId, { state: "done" });
        })
        .catch((err: unknown) => report(e.deviceId, { state: "error", message: errorMessage(err) }));
    }
    return () => {
      stale = true;
    };
  }, [debounced, archived, device, threadsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nothing typed: the most recently used threads, as a switcher.
  const recent = useMemo<Result[]>(() => {
    if (debounced) return [];
    const rows: Result[] = [];
    for (const e of devices) {
      for (const t of e.threads.data ?? []) {
        if (t.archivedAt && !archived) continue;
        rows.push({ deviceId: e.deviceId, hit: { ...fromThread(t), score: 0 } });
      }
    }
    return rows.sort((a, b) => b.hit.at - a.hit.at).slice(0, RECENT);
  }, [debounced, devices, archived]);

  const shown = debounced ? results : recent;
  useEffect(() => setSelected(0), [debounced, archived, device]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function open(r: Result | undefined) {
    if (!r) return;
    onClose();
    void navigate({
      to: "/d/$deviceId/t/$threadId",
      params: { deviceId: r.deviceId, threadId: r.hit.threadId },
      search: r.hit.tabId ? { tab: r.hit.tabId } : {},
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setSelected((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      open(shown[selected]);
    }
  }

  const searching = Object.values(status).some((s) => s.state === "searching");
  const problems = Object.entries(status).filter(([, s]) => s.state === "offline" || s.state === "error");
  const nameOf = (id: string) => {
    const e = entries.get(id);
    return e ? deviceName(e) : "Device";
  };

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        onKeyDown={onKeyDown}
        className="fixed inset-0 z-50 flex flex-col bg-popover text-popover-foreground shadow-2xl shadow-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.99] md:inset-x-[max(1.5rem,calc(50%-34rem))] md:inset-y-[6vh] md:rounded-xl md:border"
      >
        <DialogPrimitive.Title className="sr-only">Search threads</DialogPrimitive.Title>
        <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          {searching ? (
            <LoaderIcon className="size-5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <SearchIcon className="size-5 shrink-0 text-muted-foreground" />
          )}
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search every thread: names, messages, commands, paths…"
            aria-label="Search threads"
            aria-controls="search-results"
            aria-activedescendant={shown[selected] ? `search-result-${selected}` : undefined}
            className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Esc
          </button>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2 text-xs">
          {all.length > 1 && (
            <>
              <Chip on={device === null} onClick={() => setDevice(null)}>
                All devices
              </Chip>
              {all.map((e) => (
                <Chip key={e.deviceId} on={device === e.deviceId} onClick={() => setDevice(e.deviceId)}>
                  {deviceName(e)}
                </Chip>
              ))}
              <span className="mx-1 h-4 w-px bg-border" />
            </>
          )}
          <Chip on={archived} onClick={() => setArchived((a) => !a)}>
            <ArchiveIcon className="size-3" />
            Archived
          </Chip>
          <span className="ml-auto text-muted-foreground">
            {debounced
              ? `${results.length} thread${results.length === 1 ? "" : "s"}`
              : "Recent threads"}
          </span>
        </div>
        {problems.length > 0 && debounced && (
          <div className="shrink-0 border-b px-4 py-1.5 text-xs text-muted-foreground">
            {problems
              .map(([id, s]) => `${nameOf(id)} ${s.state === "offline" ? "is offline, so its threads aren't searched" : `couldn't search: ${(s as { message: string }).message}`}`)
              .join(" · ")}
          </div>
        )}
        <ul id="search-results" ref={listRef} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-2">
          {shown.map((r, i) => (
            <ResultRow
              key={`${r.deviceId}/${r.hit.threadId}`}
              index={i}
              result={r}
              terms={terms}
              selected={i === selected}
              device={all.length > 1 ? nameOf(r.deviceId) : undefined}
              project={r.hit.projectName ?? entries.get(r.deviceId)?.projects.data?.find((p) => p.id === r.hit.projectId)?.name}
              onHover={() => setSelected(i)}
              onOpen={() => open(r)}
            />
          ))}
          {debounced && !searching && results.length === 0 && (
            <li className="px-3 py-10 text-center text-sm text-muted-foreground">
              Nothing found for “{debounced}”.
              <span className="mt-1 block text-xs">
                Every word must appear in one message (or the name); “quote a phrase” to keep its words together.
              </span>
            </li>
          )}
        </ul>
        <div className="hidden shrink-0 items-center gap-4 border-t px-4 py-2 text-[11px] text-muted-foreground md:flex">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move
          </span>
          <span>
            <Kbd>Enter</Kbd> to open
          </span>
          <span className="ml-auto">
            <Kbd>{formatShortcut(shortcut)}</Kbd> opens this anywhere
          </span>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function fromThread(t: Thread): Omit<Result["hit"], "score"> {
  return {
    threadId: t.id,
    name: t.name,
    kind: t.kind,
    projectId: t.projectId,
    archivedAt: t.archivedAt,
    doneAt: t.doneAt,
    pinnedAt: t.pinnedAt,
    at: Math.max(t.lastOpenedAt ?? 0, t.seenAt ?? 0, t.createdAt),
  };
}

const ROLE = {
  user: { icon: MessageSquareIcon, label: "You" },
  assistant: { icon: SparklesIcon, label: "Claude" },
  tool: { icon: WrenchIcon, label: "Tool" },
  name: { icon: TagIcon, label: "Name" },
} as const;

function ResultRow({
  index,
  result: { deviceId, hit },
  terms,
  selected,
  device,
  project,
  onHover,
  onOpen,
}: {
  index: number;
  result: Result;
  terms: string[];
  selected: boolean;
  device?: string;
  project?: string;
  onHover(): void;
  onOpen(): void;
}) {
  const role = hit.snippet && hit.role && hit.role !== "name" ? ROLE[hit.role] : undefined;
  const where = [device, project].filter(Boolean).join(" · ");
  return (
    <li
      id={`search-result-${index}`}
      data-index={index}
      role="option"
      aria-selected={selected}
      onMouseMove={onHover}
      onClick={onOpen}
      className={cn("cursor-pointer rounded-lg px-3 py-2", selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/40")}
    >
      <div className="flex min-w-0 items-center gap-2">
        <KindIcon kind={hit.kind} deviceId={deviceId} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium">
          <Marked text={hit.name} terms={terms} />
        </span>
        {hit.pinnedAt && <PinIcon aria-label="Pinned" className="size-3 shrink-0 text-muted-foreground" />}
        {hit.doneAt && <CircleCheckIcon aria-label="Done" className="size-3 shrink-0 text-muted-foreground" />}
        {hit.archivedAt && (
          <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground uppercase">archived</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-xs text-muted-foreground">
          {where && <span className="max-w-[16rem] truncate">{where}</span>}
          <span className="tabular-nums" title={new Date(hit.at).toLocaleString()}>
            {timeAgo(hit.at)}
          </span>
        </span>
      </div>
      {hit.snippet && (
        <div className="mt-1 flex min-w-0 gap-2 pl-6 text-xs text-muted-foreground">
          {role && (
            <span className="flex shrink-0 items-center gap-1" title={role.label}>
              <role.icon className="size-3" />
            </span>
          )}
          <span className={cn("line-clamp-2 min-w-0 break-words", hit.role === "tool" && "font-mono")}>
            <Marked text={hit.snippet} terms={terms} />
          </span>
          {(hit.matches ?? 0) > 1 && <span className="ml-auto shrink-0 tabular-nums">{hit.matches} matches</span>}
        </div>
      )}
    </li>
  );
}

function Marked({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlight(text, terms).map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded-sm bg-primary/25 text-foreground">
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "flex h-6 items-center gap-1 rounded-full border px-2.5 transition-colors",
        on ? "border-primary/50 bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border bg-muted px-1 font-sans text-[10px]">{children}</kbd>;
}
