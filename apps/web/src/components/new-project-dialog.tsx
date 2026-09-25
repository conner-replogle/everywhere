import type { DirListing, Project } from "@everywhere/protocol";
import { Link } from "@tanstack/react-router";
import { CornerLeftUpIcon, FolderIcon, GitForkIcon, HomeIcon, LinkIcon, LoaderIcon, LockIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GithubMark } from "@/components/github-mark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type GithubRepo } from "@/lib/api";
import type { DevicePeer } from "@/lib/peer";
import { cn, errorMessage } from "@/lib/utils";

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "/";
}

/** The folder a clone of url lands in: the repo's name. */
function repoFolder(url: string): string {
  return (
    url
      .trim()
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .pop() ?? ""
  );
}

type Source = "folder" | "github" | "url";

export function NewProjectDialog({
  peer,
  deviceId,
  home,
  canClone,
  open,
  onOpenChange,
  onCreated,
}: {
  peer: DevicePeer;
  deviceId: string;
  /** Device $HOME, the picker's starting point. */
  home: string | undefined;
  /** The daemon can clone (projects.clone). */
  canClone: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (p: Project) => void;
}) {
  const [source, setSource] = useState<Source>("folder");
  const dirs = useDirBrowser(peer, home, open);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Cloning: what, and the folder it goes in (under the browsed directory).
  const [repo, setRepo] = useState<GithubRepo | null>(null);
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [folderEdited, setFolderEdited] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSource("folder");
    setName("");
    setError(null);
    setBusy(false);
    setRepo(null);
    setUrl("");
    setFolder("");
    setFolderEdited(false);
  }, [open]);

  const suggestFolder = (f: string) => {
    if (!folderEdited) setFolder(f);
  };
  const clonePath = folder.trim() ? joinPath(dirs.path.trim(), folder.trim()) : "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const projectName = name.trim() || undefined;
    try {
      let project: Project;
      if (source === "folder") {
        project = await peer.call("projects.create", { path: dirs.path.trim(), ...(projectName ? { name: projectName } : {}) });
      } else if (source === "github") {
        project = await api.cloneGithubRepo(deviceId, repo!.fullName, clonePath, projectName);
      } else {
        project = await peer.call("projects.clone", { url: url.trim(), path: clonePath, ...(projectName ? { name: projectName } : {}) });
      }
      onCreated(project);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const ready =
    source === "folder" ? !!dirs.path.trim() : source === "github" ? !!repo && !!clonePath : !!url.trim() && !!clonePath;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={submit} className="grid min-w-0 gap-4">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              {source === "folder"
                ? "Pick a directory on this device. Threads in the project start their shell there."
                : "Clone a repository onto this device. The project opens while it downloads."}
            </DialogDescription>
          </DialogHeader>

          {canClone && (
            <div role="tablist" aria-label="Source" className="grid grid-cols-3 gap-1 rounded-md border bg-background/60 p-0.5">
              <SourceTab active={source === "folder"} onClick={() => setSource("folder")} icon={<FolderIcon />} label="Folder" />
              <SourceTab active={source === "github"} onClick={() => setSource("github")} icon={<GithubMark />} label="GitHub" />
              <SourceTab active={source === "url"} onClick={() => setSource("url")} icon={<LinkIcon />} label="Git URL" />
            </div>
          )}

          {source === "github" && (
            <GithubRepoPicker
              open={open}
              selected={repo}
              onSelect={(r) => {
                setRepo(r);
                if (r) suggestFolder(basename(r.fullName));
              }}
            />
          )}

          {source === "url" && (
            <div className="grid gap-1.5">
              <Label htmlFor="clone-url">Repository URL</Label>
              <Input
                id="clone-url"
                className="font-mono text-xs"
                value={url}
                placeholder="https://github.com/owner/repo.git"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setUrl(e.target.value);
                  suggestFolder(repoFolder(e.target.value));
                }}
              />
              <p className="text-xs text-muted-foreground">Uses the device's own git credentials (SSH keys, credential helper).</p>
            </div>
          )}

          <DirPicker dirs={dirs} home={home} label={source === "folder" ? "Directory" : "Clone into"} compact={source !== "folder"} />

          {source !== "folder" && (
            <div className="grid gap-1.5">
              <Label htmlFor="clone-folder">Folder</Label>
              <Input
                id="clone-folder"
                className="font-mono text-xs"
                value={folder}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setFolder(e.target.value);
                  setFolderEdited(true);
                }}
              />
              {clonePath && <p className="truncate font-mono text-xs text-muted-foreground" title={clonePath}>{clonePath}</p>}
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="project-name">Name (optional)</Label>
            <Input
              id="project-name"
              value={name}
              placeholder={source === "folder" ? basename(dirs.path) : folder || "Project name"}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {error && <p className="text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !ready}>
              {busy && <LoaderIcon className="animate-spin" />}
              {source === "folder" ? "Create project" : "Clone"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SourceTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center justify-center gap-1.5 rounded-sm text-xs focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none [&_svg]:size-3.5",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** The connected account's repos, filtered by what's typed; owner/name finds any other. */
function GithubRepoPicker({
  open,
  selected,
  onSelect,
}: {
  open: boolean;
  selected: GithubRepo | null;
  onSelect: (r: GithubRepo | null) => void;
}) {
  // undefined while loading; null when not connected.
  const [repos, setRepos] = useState<GithubRepo[] | null | undefined>();
  const [configured, setConfigured] = useState(true);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      try {
        const s = await api.githubStatus();
        if (!live) return;
        setConfigured(s.configured);
        if (!s.login) return setRepos(null);
        const list = await api.githubRepos();
        if (live) setRepos(list);
      } catch (e) {
        if (live) {
          setError(errorMessage(e));
          setRepos([]);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => (repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q)).slice(0, 50),
    [repos, q],
  );
  // A repo outside the list (someone else's, or older than the newest 100).
  const exact = /^[\w.-]+\/[\w.-]+$/.test(query.trim()) && !matches.some((r) => r.fullName.toLowerCase() === q);

  const lookup = async () => {
    setLooking(true);
    setError(null);
    try {
      onSelect(await api.githubRepo(query.trim()));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLooking(false);
    }
  };

  if (repos === null) {
    return (
      <div className="rounded-md border bg-background/60 px-3 py-3 text-xs text-muted-foreground">
        {configured ? "Connect a GitHub account to pick from your repositories. " : "GitHub isn't set up on this server. "}
        <Link to="/settings/github" className="text-foreground underline underline-offset-2">
          {configured ? "Connect GitHub" : "How to set it up"}
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor="repo-search">Repository</Label>
      <Input
        id="repo-search"
        value={selected && !query ? selected.fullName : query}
        placeholder="Search your repositories, or owner/name"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          if (selected) onSelect(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && exact) {
            e.preventDefault();
            void lookup();
          }
        }}
      />
      {!selected && (
        <div className="h-44 overflow-y-auto rounded-md border bg-background/60 p-1" role="listbox" aria-label="Repositories">
          {repos === undefined ? (
            <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
              <LoaderIcon className="size-3 animate-spin" /> Loading…
            </p>
          ) : (
            <>
              {exact && (
                <RepoRow
                  label={looking ? `Looking up ${query.trim()}…` : `Clone ${query.trim()}`}
                  onClick={() => void lookup()}
                />
              )}
              {matches.map((r) => (
                <RepoRow
                  key={r.fullName}
                  label={r.fullName}
                  description={r.description}
                  isPrivate={r.private}
                  fork={r.fork}
                  onClick={() => {
                    setQuery("");
                    onSelect(r);
                  }}
                />
              ))}
              {matches.length === 0 && !exact && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No matching repositories.</p>
              )}
            </>
          )}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function RepoRow({
  label,
  description,
  isPrivate,
  fork,
  onClick,
}: {
  label: string;
  description?: string | null;
  isPrivate?: boolean;
  fork?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={false}
      onClick={onClick}
      title={description ?? undefined}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none [&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
    >
      <span className="truncate font-mono">{label}</span>
      {fork && <GitForkIcon aria-label="fork" />}
      {isPrivate && <LockIcon aria-label="private" />}
      {description && <span className="ml-auto truncate pl-2 text-muted-foreground">{description}</span>}
    </button>
  );
}

interface DirBrowser {
  path: string;
  setPath: (p: string) => void;
  listing: DirListing | null;
  listError: string | null;
  loading: boolean;
  browse: (target: string) => Promise<void>;
}

function useDirBrowser(peer: DevicePeer, home: string | undefined, open: boolean): DirBrowser {
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<DirListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const req = useRef(0);

  const browse = useCallback(
    async (target: string) => {
      const id = ++req.current;
      setLoading(true);
      setListError(null);
      try {
        const res = await peer.call("fs.listDirs", { path: target });
        if (id !== req.current) return;
        setListing(res);
        setPath(res.path);
      } catch (e) {
        if (id === req.current) setListError(errorMessage(e));
      } finally {
        if (id === req.current) setLoading(false);
      }
    },
    [peer],
  );

  useEffect(() => {
    if (!open) return;
    setListing(null);
    setPath(home ?? "~");
    void (async () => {
      // Fall back to asking the device if the caller didn't know $HOME yet.
      const dir = home ?? (await peer.call("device.info", {}).then((i) => i.home, () => "/"));
      await browse(dir);
    })();
  }, [open, home, peer, browse]);

  return { path, setPath, listing, listError, loading, browse };
}

function DirPicker({
  dirs: { path, setPath, listing, listError, loading, browse },
  home,
  label,
  compact,
}: {
  dirs: DirBrowser;
  home: string | undefined;
  label: string;
  compact?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="project-path">{label}</Label>
      <Input
        id="project-path"
        className="font-mono text-xs"
        value={path}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void browse(path.trim());
          }
        }}
        onBlur={() => {
          if (listing && path.trim() !== listing.path) void browse(path.trim());
        }}
      />
      <div
        className={cn("overflow-y-auto rounded-md border bg-background/60 p-1", compact ? "h-32" : "h-56")}
        role="listbox"
        aria-label="Subdirectories"
        aria-busy={loading}
      >
        {listError ? (
          <p className="px-2 py-1.5 text-xs text-destructive">{listError}</p>
        ) : !listing ? (
          <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <LoaderIcon className="size-3 animate-spin" /> Loading…
          </p>
        ) : (
          <>
            {home && listing.path !== home && <DirRow icon={<HomeIcon />} label="~" onClick={() => browse(home)} muted />}
            {listing.parent !== null && (
              <DirRow icon={<CornerLeftUpIcon />} label=".." onClick={() => browse(listing.parent!)} muted />
            )}
            {listing.dirs.map((d) => (
              <DirRow key={d} icon={<FolderIcon />} label={d} onClick={() => browse(joinPath(listing.path, d))} />
            ))}
            {listing.dirs.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No subdirectories.</p>}
          </>
        )}
      </div>
    </div>
  );
}

function DirRow({
  icon,
  label,
  onClick,
  muted,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={false}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left font-mono text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        muted && "text-muted-foreground",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
