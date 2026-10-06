import type { Process } from "@everywhere/protocol";
import { ActivityIcon, GlobeIcon, PlayIcon, RotateCcwIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TerminalView } from "@/components/terminal-view";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DevicePeer } from "@/lib/peer";
import { cn, errorMessage } from "@/lib/utils";
import { useProcesses } from "./use-processes";
import {
  CheckpointTrack,
  formatDuration,
  isRunning,
  StatRow,
  StatusMark,
  statusLabel,
  TerminalProgress,
  useNow,
} from "./progress";

interface ProcessesState {
  selected?: string;
}

function parseState(s?: string): ProcessesState {
  try {
    return s ? (JSON.parse(s) as ProcessesState) : {};
  } catch {
    return {};
  }
}

export function ProcessesView({
  peer,
  threadId,
  generation,
  initialState,
  onStateChange,
  onOpenUrl,
  show,
}: {
  peer: DevicePeer;
  /** The thread whose processes these are. */
  threadId: string;
  generation: number;
  initialState?: string;
  onStateChange?: (state: string) => void;
  /** Opens a URL a process printed in the thread's browser. */
  onOpenUrl?: (url: string) => void;
  /** A process to select (e.g. picked in the claude tab's overview); at makes picking it again count. */
  show?: { id: string; at: number };
}) {
  const list = useProcesses(peer, threadId);
  const { refetch } = list;

  const processes = list.data ?? [];
  const [selected, setSelected] = useState(() => parseState(initialState).selected);
  const shown = processes.find((p) => p.id === selected) ?? processes.find(isRunning) ?? processes[0];
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const select = (id: string) => {
    setSelected(id);
    onStateChangeRef.current?.(JSON.stringify({ selected: id } satisfies ProcessesState));
  };

  const showAt = show?.at;
  const showId = show?.id;
  useEffect(() => {
    if (showId) select(showId);
    // Only a new request selects; select itself changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showId, showAt]);

  const now = useNow(processes.some(isRunning));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
      refetch();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const active = processes.filter(isRunning).length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="text-muted-foreground">
          {processes.length === 0 ? "No processes" : active > 0 ? `${active} running` : "None running"}
        </span>
        {error && (
          <span className="min-w-0 truncate text-destructive" title={error}>
            {error}
          </span>
        )}
        <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={() => setRunning(true)}>
          <PlayIcon />
          Run
        </Button>
      </div>
      {processes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
          <ActivityIcon className="size-5" />
          {list.error ? (
            <p className="text-destructive">{list.error}</p>
          ) : (
            <p className="max-w-72">
              Dev servers, builds and scripts Claude starts show up here with their progress and logs. You can run one
              yourself too.
            </p>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 max-md:flex-col">
          <ul className="flex min-h-0 shrink-0 flex-col gap-2 overflow-y-auto p-2 max-md:max-h-[45%] max-md:border-b md:w-96 md:border-r">
            {processes.map((p) => (
              <li key={p.id}>
                <ProcessCard
                  process={p}
                  now={now}
                  selected={p.id === shown?.id}
                  onSelect={() => select(p.id)}
                  onStop={() => act(() => peer.call("processes.stop", { id: p.id }, 15_000))}
                  onRestart={() => act(() => peer.call("processes.restart", { id: p.id }, 15_000))}
                  onRemove={() => act(() => peer.call("processes.remove", { id: p.id }, 15_000))}
                  onOpenUrl={onOpenUrl}
                />
              </li>
            ))}
          </ul>
          <div className="relative min-h-0 min-w-0 flex-1">
            {shown?.command ? (
              <TerminalView
                // A new run is a new log.
                key={`${shown.id}:${shown.startedAt}`}
                peer={peer}
                threadId={threadId}
                processId={shown.id}
                generation={generation}
              />
            ) : shown ? (
              <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">
                A tracker has no output: Claude reports its progress as it works.
              </div>
            ) : null}
          </div>
        </div>
      )}
      <RunDialog
        open={running}
        onOpenChange={setRunning}
        onSubmit={async (name, command) => {
          const p = await peer.call("processes.start", { threadId, name, command });
          refetch();
          select(p.id);
        }}
      />
    </div>
  );
}

function ProcessCard({
  process: p,
  now,
  selected,
  onSelect,
  onStop,
  onRestart,
  onRemove,
  onOpenUrl,
}: {
  process: Process;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onStop: () => Promise<void>;
  onRestart: () => Promise<void>;
  onRemove: () => Promise<void>;
  onOpenUrl?: (url: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = (f: () => Promise<void>) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    void f().finally(() => setBusy(false));
  };
  const running = isRunning(p);
  const elapsed = formatDuration(((p.endedAt ?? now) - p.startedAt) / 1000);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && onSelect()}
      className={cn(
        "grid gap-2 rounded-md border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary/50 bg-accent/40" : "hover:bg-accent/30",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusMark process={p} />
        <span className="min-w-0 truncate text-sm font-medium">{p.name}</span>
        <span className="text-xs text-muted-foreground">{statusLabel(p)}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{elapsed}</span>
        <div className="flex shrink-0 items-center">
          {running && (
            <Button variant="ghost" size="icon-sm" disabled={busy} onClick={run(onStop)} aria-label="Stop" title="Stop">
              <SquareIcon />
            </Button>
          )}
          {p.command && (
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              onClick={run(onRestart)}
              aria-label="Restart"
              title={running ? "Restart" : "Run again"}
            >
              <RotateCcwIcon />
            </Button>
          )}
          {!running && (
            <Button variant="ghost" size="icon-sm" disabled={busy} onClick={run(onRemove)} aria-label="Remove" title="Remove">
              <Trash2Icon />
            </Button>
          )}
        </div>
      </div>
      <div className="truncate font-mono text-[11px] text-muted-foreground" title={p.command ?? p.cwd}>
        {p.command ?? "Tracker"}
      </div>
      {p.checkpoints.length > 0 && <CheckpointTrack process={p} now={now} />}
      {p.checkpoints.length === 0 && running && <TerminalProgress process={p} />}
      {p.stats.map((s) => (
        <StatRow key={s.key} stat={s} live={running} />
      ))}
      {p.statusText && <div className="truncate text-xs">{p.statusText}</div>}
      {!p.statusText && running && p.lastLine && (
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={p.lastLine}>
          {p.lastLine}
        </div>
      )}
      {running && p.urls && p.urls.length > 0 && onOpenUrl && (
        <div className="flex flex-wrap gap-1">
          {p.urls.map((u) => (
            <Button
              key={u}
              variant="secondary"
              size="sm"
              className="h-6 font-mono text-[11px]"
              title="Open in this thread's browser"
              onClick={(e) => {
                e.stopPropagation();
                onOpenUrl(u);
              }}
            >
              <GlobeIcon />
              {u.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function RunDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (name: string, command: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setCommand("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cmd = command.trim();
    if (!cmd) return;
    // Named after the program unless given a name.
    const n = name.trim() || cmd.split(/\s+/)[0]!.split("/").pop()!.slice(0, 64);
    setBusy(true);
    try {
      await onSubmit(n, cmd);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Run a command</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="process-command">Command</Label>
            <Input
              id="process-command"
              autoFocus
              className="font-mono"
              placeholder="npm run dev"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="process-name">Name</Label>
            <Input id="process-name" placeholder="dev" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {error && <p className="text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !command.trim()}>
              Run
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
