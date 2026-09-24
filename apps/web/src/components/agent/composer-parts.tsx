// Composer pieces around the text box: where the thread runs, how full the
// context is, and attached files.

import type { AgentAttachment, AgentContext, AgentWorkspace, GitInfo } from "@everywhere/protocol";
import { ChevronDownIcon, FileIcon, GitBranchIcon, ImageIcon, LoaderIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DevicePeer } from "@/lib/peer";
import { cn, errorMessage } from "@/lib/utils";

// --- workspace -------------------------------------------------------------------

/**
 * Before the first message: run in the project checkout or a new worktree
 * from a chosen branch. Afterwards: which worktree branch the thread is on.
 */
export function WorkspacePicker({
  workspace,
  git,
  disabled,
  onPick,
}: {
  workspace: AgentWorkspace;
  /** Undefined while loading or when the daemon can't do worktrees. */
  git: GitInfo | undefined;
  disabled: boolean;
  onPick: (mode: "local" | "worktree", baseBranch?: string) => void;
}) {
  if (workspace.locked) {
    if (workspace.mode !== "worktree" || !workspace.branch) return null;
    return (
      <span
        className="flex h-6 min-w-0 items-center gap-1 px-2 text-xs text-muted-foreground"
        title={workspace.path ? `Worktree at ${workspace.path}` : undefined}
      >
        <GitBranchIcon className="size-3 shrink-0" />
        <span className="truncate font-mono">{workspace.branch}</span>
      </span>
    );
  }
  if (!git?.isRepo) return null;

  const base = workspace.baseBranch || git.current;
  const label = workspace.mode === "worktree" ? `New worktree from ${base || "HEAD"}` : "Local checkout";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant="ghost" size="sm" className="h-6 max-w-56 px-2 font-normal">
          <GitBranchIcon className="size-3" />
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-80 overflow-y-auto">
        <DropdownMenuLabel>Where Claude works</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onPick("local")}>
          <div className="grid">
            <span className={cn(workspace.mode === "local" && "text-primary")}>Local checkout</span>
            <span className="text-xs text-muted-foreground">Edits the project directory directly</span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>New worktree from…</DropdownMenuLabel>
        {git.branches.map((b) => (
          <DropdownMenuItem key={b} onSelect={() => onPick("worktree", b === git.current ? "" : b)}>
            <span className={cn("font-mono text-xs", workspace.mode === "worktree" && b === base && "text-primary")}>
              {b}
            </span>
            {b === git.current && <span className="ml-auto text-xs text-muted-foreground">current</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- context -----------------------------------------------------------------------

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

/** A ring showing how full the context window is. */
export function ContextMeter({ context }: { context: AgentContext | undefined }) {
  if (!context || context.max <= 0) return null;
  const pct = Math.min(100, Math.max(0, context.percentage));
  const r = 6;
  const circumference = 2 * Math.PI * r;
  const tone = pct >= 90 ? "text-destructive" : pct >= 75 ? "text-warn" : "text-muted-foreground";
  const label = `${formatTokens(context.used)} of ${formatTokens(context.max)} tokens of context used (${Math.round(pct)}%). ${
    pct >= 75 ? "Claude compacts the conversation when it fills up." : ""
  }`;
  return (
    <span className={cn("flex h-6 shrink-0 items-center gap-1 px-1.5 text-xs tabular-nums", tone)} title={label}>
      <svg viewBox="0 0 16 16" className="size-3.5 -rotate-90" aria-hidden>
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
        />
      </svg>
      <span className="max-sm:hidden">{Math.round(pct)}%</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

// --- attachments -------------------------------------------------------------------

const MAX_IMAGE_BYTES = 10 << 20;
const MAX_FILE_BYTES = 50 << 20;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface PendingAttachment {
  key: string;
  file: File;
  sent: number;
  attachment?: AgentAttachment;
  error?: string;
  /** Object URL for image previews; revoked on removal. */
  preview?: string;
}

/** Uploads files as soon as they're added, so sending doesn't wait on them. */
export function useAttachments(peer: DevicePeer, threadId: string) {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const seq = useRef(0);

  const update = useCallback((key: string, patch: Partial<PendingAttachment>) => {
    setItems((prev) => prev.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  }, []);

  const add = useCallback(
    (files: Iterable<File>) => {
      for (const file of files) {
        const key = `a${++seq.current}`;
        const image = IMAGE_TYPES.has(file.type);
        const limit = image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
        const item: PendingAttachment = {
          key,
          file,
          sent: 0,
          preview: image ? URL.createObjectURL(file) : undefined,
          error: file.size > limit ? `Over the ${limit >> 20} MB limit` : file.size === 0 ? "Empty file" : undefined,
        };
        setItems((prev) => [...prev, item]);
        if (item.error) continue;
        peer
          .upload(threadId, file, (sent) => update(key, { sent }))
          .then((attachment) => update(key, { attachment }))
          .catch((e: unknown) => update(key, { error: errorMessage(e) }));
      }
    },
    [peer, threadId, update],
  );

  const remove = useCallback((key: string) => {
    setItems((prev) => {
      const gone = prev.find((a) => a.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return prev.filter((a) => a.key !== key);
    });
  }, []);

  /** Forget everything after a send; previews are kept by the sent message. */
  const clear = useCallback(() => setItems([]), []);

  // Revoke whatever previews are left when the thread closes.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(
    () => () => {
      for (const a of itemsRef.current) if (a.preview) URL.revokeObjectURL(a.preview);
    },
    [],
  );

  const uploading = items.some((a) => !a.attachment && !a.error);
  const ready = items.filter((a) => a.attachment).map((a) => a.attachment!);
  return { items, add, remove, clear, uploading, ready };
}

export function AttachmentChips({
  items,
  onRemove,
}: {
  items: PendingAttachment[];
  onRemove: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-2 pt-2">
      {items.map((a) => {
        const pct = a.file.size ? Math.round((a.sent / a.file.size) * 100) : 0;
        return (
          <div
            key={a.key}
            className={cn(
              "flex h-8 max-w-56 items-center gap-1.5 rounded-md border bg-secondary pr-1 pl-1 text-xs",
              a.error && "border-destructive/50 text-destructive",
            )}
            title={a.error ?? `${a.file.name} · ${formatBytes(a.file.size)}`}
          >
            {a.preview ? (
              <img src={a.preview} alt="" className="size-6 rounded-sm object-cover" />
            ) : (
              <FileIcon className="ml-0.5 size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 truncate">{a.file.name || "pasted image"}</span>
            {!a.attachment && !a.error && (
              <span className="flex shrink-0 items-center gap-1 text-muted-foreground tabular-nums">
                <LoaderIcon className="size-3 animate-spin" />
                {pct}%
              </span>
            )}
            <button
              type="button"
              onClick={() => onRemove(a.key)}
              className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={`Remove ${a.file.name}`}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Chips for the files sent with a message, in the timeline. */
export function SentAttachments({ attachments }: { attachments: AgentAttachment[] }) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {attachments.map((a) => (
        <span
          key={a.id}
          className="flex h-6 max-w-56 items-center gap-1.5 rounded-md border px-1.5 text-xs text-muted-foreground"
          title={`${a.name} · ${formatBytes(a.size)}`}
        >
          {a.kind === "image" ? <ImageIcon className="size-3 shrink-0" /> : <FileIcon className="size-3 shrink-0" />}
          <span className="truncate">{a.name}</span>
        </span>
      ))}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
