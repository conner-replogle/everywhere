// Scratch: each device's place for general computer work outside any
// project. A thread there works in a fresh folder of its own on the device
// (the daemon makes it), and a claude thread starts in auto mode.

import type { Project, Thread, ThreadKind } from "@everywhere/protocol";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, ChevronDownIcon, LoaderIcon, MonitorIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DeviceContextValue } from "@/components/device-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, errorMessage } from "@/lib/utils";

type Entry = DeviceContextValue;

export const deviceName = (e: Entry) => e.device.name || e.info.data?.hostname || "Device";

/** The device's Scratch project, once its daemon has reported one. */
export const scratchProject = (e: Entry): Project | undefined => e.projects.data?.find((p) => p.isScratch);
export const homeProject = (e: Entry): Project | undefined => e.projects.data?.find((p) => p.isHome);

/** Whether a Scratch thread can be started on the device now. */
export const canScratch = (e: Entry) => e.conn.state === "connected" && !!scratchProject(e);

/** Scratch threads, most recently used first. */
export function scratchThreads(e: Entry, archived = false): Thread[] {
  const id = scratchProject(e)?.id;
  if (!id) return [];
  return (e.threads.data ?? [])
    .filter((t) => t.projectId === id && !!t.archivedAt === archived)
    .sort((a, b) => threadRecency(b) - threadRecency(a));
}

/** When a thread was last used (a prompt sent, keys typed), or else created. */
export const threadRecency = (t: Thread) => Math.max(t.lastOpenedAt ?? 0, t.createdAt);

/** Starts a Scratch thread; a claude one sends prompt as its first message. */
export async function startScratch(e: Entry, kind: ThreadKind, prompt?: string): Promise<Thread> {
  const project = scratchProject(e);
  if (!project) throw new Error(`${deviceName(e)} doesn't have Scratch yet; update its daemon`);
  const t = await e.peer.call("threads.create", {
    projectId: project.id,
    kind,
    ...(prompt?.trim() ? { prompt: prompt.trim() } : {}),
  });
  e.threads.refetch();
  return t;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const LAST_DEVICE_KEY = "ew:scratch-device";

/** The device the launcher last started on, remembered per browser. */
function rememberedDevice(): string | null {
  try {
    return localStorage.getItem(LAST_DEVICE_KEY);
  } catch {
    return null;
  }
}

/**
 * A box for starting a Scratch thread: type what's needed and Start opens
 * a claude thread with it; Terminal opens a shell in a fresh folder. With several devices, a picker chooses which.
 */
export function ScratchComposer({
  entries,
  deviceId,
  autoFocus,
  className,
}: {
  /** The devices it can start on; a single one hides the picker. */
  entries: Entry[];
  /** Fixed device (the device page); otherwise the last one used, or the first that's connected. */
  deviceId?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string | null>(() => deviceId ?? rememberedDevice());
  const [busy, setBusy] = useState<ThreadKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const usable = entries.filter(canScratch);
  const entry =
    entries.find((e) => e.deviceId === (deviceId ?? picked) && (deviceId || canScratch(e))) ?? (deviceId ? undefined : usable[0]);
  const ready = !!entry && canScratch(entry);

  // Grow with the text, up to a point.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  async function start(kind: ThreadKind) {
    const prompt = text;
    if (!entry || busy) return;
    if (kind === "claude" && !prompt.trim()) {
      ref.current?.focus();
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      const t = await startScratch(entry, kind, kind === "claude" ? prompt : undefined);
      try {
        localStorage.setItem(LAST_DEVICE_KEY, entry.deviceId);
      } catch {
        // Only a convenience.
      }
      setText("");
      await navigate({ to: "/d/$deviceId/t/$threadId", params: { deviceId: entry.deviceId, threadId: t.id } });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const name = entry ? deviceName(entry) : "a device";
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-2", className)}>
      <div className="rounded-lg border bg-background/60 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
        <textarea
          ref={ref}
          value={text}
          rows={2}
          autoFocus={autoFocus}
          disabled={!ready}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void start("claude");
            }
          }}
          placeholder={ready ? `What do you need done on ${name}?` : `${name} isn't connected`}
          aria-label={`Start a Scratch thread on ${name}`}
          className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[13px] outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          {!deviceId && entries.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-6 max-w-48 min-w-0 px-2 font-normal">
                  <MonitorIcon className="size-3" />
                  <span className="truncate">{name}</span>
                  <ChevronDownIcon className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Start on</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={entry?.deviceId ?? ""} onValueChange={(id) => setPicked(id)}>
                  {entries.map((e) => (
                    <DropdownMenuRadioItem key={e.deviceId} value={e.deviceId} disabled={!canScratch(e)}>
                      {deviceName(e)}
                      {!canScratch(e) && (
                        <span className="ml-2 text-[11px] text-muted-foreground">
                          {e.conn.state === "connected" ? "needs an update" : "offline"}
                        </span>
                      )}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <span className="truncate px-1 text-[11px] text-muted-foreground">Works in a fresh Scratch folder</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7"
            disabled={!ready || !!busy}
            onClick={() => void start("terminal")}
            title="Open a terminal in a fresh Scratch folder"
          >
            {busy === "terminal" ? <LoaderIcon className="animate-spin" /> : <SquareTerminalIcon />}
            Terminal
          </Button>
          <Button
            size="icon-sm"
            className="size-7"
            disabled={!ready || !!busy || !text.trim()}
            onClick={() => void start("claude")}
            aria-label="Start"
            title="Start a Claude thread"
          >
            {busy === "claude" ? <LoaderIcon className="animate-spin" /> : <ArrowUpIcon />}
          </Button>
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
