import type { GitStatus } from "@everywhere/protocol";
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpIcon,
  FolderGit2Icon,
  GitBranchIcon,
  LoaderIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type DevicePeer, useRpc } from "@/lib/peer";
import { cn, errorMessage, timeAgo } from "@/lib/utils";

/** Local changes (an agent's edits) don't announce themselves; look again this often. */
const REFRESH_MS = 20_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The thread's checkout: branch, sync with its upstream and origin's default branch, and changes. */
export function GitChip({ peer, threadId }: { peer: DevicePeer; threadId: string }) {
  const status = useRpc(peer, "git.status", { threadId }, ["git.changed", "threads.changed"]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { refetch } = status;

  // Look again when the page comes back into view, and now and then while it's shown.
  useEffect(() => {
    const onShow = () => document.visibilityState === "visible" && refetch();
    const timer = setInterval(onShow, REFRESH_MS);
    window.addEventListener("focus", onShow);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onShow);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [refetch]);

  const s = status.data;
  if (!s?.isRepo) return null;

  const act = async (method: "git.fetch" | "git.pull" | "git.updateDefault") => {
    setBusy(method);
    setError(null);
    try {
      await peer.call(method, { threadId });
      refetch();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const changed = s.staged + s.unstaged + s.untracked + s.conflicted;
  const mainStale = s.defaultBehind > 0;
  const label = s.branch || (s.head ? `detached @ ${s.head}` : "no commits");
  const Icon = s.worktree ? FolderGit2Icon : GitBranchIcon;

  return (
    <DropdownMenu onOpenChange={(o) => o && refetch()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-6 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none data-[state=open]:bg-accent"
          title={summary(s)}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="max-w-40 truncate font-mono">{label}</span>
          {(s.ahead > 0 || s.behind > 0) && (
            <span className="flex shrink-0 items-center tabular-nums">
              {s.behind > 0 && (
                <span className="flex items-center text-warn">
                  <ArrowDownIcon className="size-3" />
                  {s.behind}
                </span>
              )}
              {s.ahead > 0 && (
                <span className="flex items-center">
                  <ArrowUpIcon className="size-3" />
                  {s.ahead}
                </span>
              )}
            </span>
          )}
          {changed > 0 && (
            <span className="shrink-0 tabular-nums max-sm:hidden">
              <span className="text-live">+{s.insertions}</span> <span className="text-destructive">−{s.deletions}</span>
            </span>
          )}
          {changed > 0 && <span className="size-1.5 shrink-0 rounded-full bg-primary sm:hidden" aria-label="changes" />}
          {mainStale && <span className="size-1.5 shrink-0 rounded-full bg-warn" aria-label={`${s.defaultBranch} is behind origin`} />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="grid gap-0.5 font-normal">
          <span className="flex items-center gap-1.5 font-medium">
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate font-mono">{label}</span>
            {s.head && s.branch && <span className="ml-auto font-mono text-xs text-muted-foreground">{s.head}</span>}
          </span>
          {s.worktree && (
            <span className="truncate text-xs text-muted-foreground" title={s.root}>
              Worktree at {s.root}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="grid gap-1 px-2 py-1 text-xs">
          <Line label="Upstream">
            {!s.upstream
              ? "none (not pushed)"
              : s.ahead === 0 && s.behind === 0
                ? `up to date with ${s.upstream}`
                : [s.behind > 0 && `${s.behind} behind`, s.ahead > 0 && `${s.ahead} ahead`].filter(Boolean).join(", ") +
                  ` ${s.upstream}`}
          </Line>
          {s.defaultBranch && s.branch !== s.defaultBranch && (
            <Line label={`origin/${s.defaultBranch}`}>
              {s.aheadOfDefault === 0 && s.behindDefault === 0
                ? "same commit"
                : [s.aheadOfDefault > 0 && `${s.aheadOfDefault} ahead`, s.behindDefault > 0 && `${s.behindDefault} behind`]
                    .filter(Boolean)
                    .join(", ")}
            </Line>
          )}
          {s.defaultBranch && s.defaultBehind !== -1 && (
            <Line label={`Local ${s.defaultBranch}`} warn={mainStale}>
              {mainStale ? `${plural(s.defaultBehind, "commit")} behind origin` : "up to date with origin"}
            </Line>
          )}
          <Line label="Changes">
            {changed === 0
              ? "clean"
              : [
                  s.conflicted > 0 && `${s.conflicted} conflicted`,
                  s.staged > 0 && `${s.staged} staged`,
                  s.unstaged > 0 && `${s.unstaged} modified`,
                  s.untracked > 0 && `${s.untracked} untracked`,
                ]
                  .filter(Boolean)
                  .join(", ") + (s.insertions || s.deletions ? ` · +${s.insertions} −${s.deletions}` : "")}
          </Line>
          <p className={cn("text-muted-foreground", s.fetchError && "text-destructive")} title={s.fetchError}>
            {s.fetching
              ? "Fetching origin…"
              : s.fetchError
                ? `Fetch failed: ${s.fetchError}`
                : s.fetchedAt
                  ? `Fetched ${timeAgo(s.fetchedAt)}`
                  : "Not fetched yet"}
          </p>
          {error && <p className="text-destructive">{error}</p>}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!!busy} onSelect={(e) => (e.preventDefault(), void act("git.fetch"))}>
          {busy === "git.fetch" ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
          Fetch origin
        </DropdownMenuItem>
        {s.upstream && s.behind > 0 && (
          <DropdownMenuItem
            disabled={!!busy || s.ahead > 0}
            title={s.ahead > 0 ? "Diverged from upstream: merge or rebase in a terminal" : undefined}
            onSelect={(e) => (e.preventDefault(), void act("git.pull"))}
          >
            {busy === "git.pull" ? <LoaderIcon className="animate-spin" /> : <ArrowDownToLineIcon />}
            Pull {plural(s.behind, "commit")}
          </DropdownMenuItem>
        )}
        {mainStale && s.branch !== s.defaultBranch && (
          <DropdownMenuItem disabled={!!busy} onSelect={(e) => (e.preventDefault(), void act("git.updateDefault"))}>
            {busy === "git.updateDefault" ? <LoaderIcon className="animate-spin" /> : <ArrowDownToLineIcon />}
            Update local {s.defaultBranch}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Line({ label, warn, children }: { label: string; warn?: boolean; children: React.ReactNode }) {
  return (
    <p className="flex gap-2">
      <span className="w-24 shrink-0 truncate text-muted-foreground">{label}</span>
      <span className={cn("min-w-0", warn && "text-warn")}>{children}</span>
    </p>
  );
}

function summary(s: GitStatus): string {
  const parts = [s.branch || "detached HEAD"];
  if (s.worktree) parts.push("worktree");
  if (s.behind) parts.push(`${s.behind} behind ${s.upstream}`);
  if (s.ahead) parts.push(`${s.ahead} ahead`);
  const changed = s.staged + s.unstaged + s.untracked + s.conflicted;
  if (changed) parts.push(`${plural(changed, "changed file")}`);
  if (s.defaultBehind > 0) parts.push(`${s.defaultBranch} is ${s.defaultBehind} behind origin`);
  return parts.join(" · ");
}
