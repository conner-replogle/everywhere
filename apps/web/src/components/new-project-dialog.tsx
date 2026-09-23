import type { DirListing, Project } from "@everywhere/protocol";
import { CornerLeftUpIcon, FolderIcon, HomeIcon, LoaderIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import type { DevicePeer } from "@/lib/peer";
import { cn, errorMessage } from "@/lib/utils";

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "/";
}

export function NewProjectDialog({
  peer,
  home,
  open,
  onOpenChange,
  onCreated,
}: {
  peer: DevicePeer;
  /** Device $HOME, the picker's starting point. */
  home: string | undefined;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (p: Project) => void;
}) {
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<DirListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    setName("");
    setError(null);
    setBusy(false);
    setListing(null);
    const start = home ?? "~";
    setPath(start);
    void (async () => {
      // Fall back to asking the device if the caller didn't know $HOME yet.
      const dir = home ?? (await peer.call("device.info", {}).then((i) => i.home, () => "/"));
      await browse(dir);
    })();
  }, [open, home, peer, browse]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const target = path.trim();
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const project = await peer.call("projects.create", {
        path: target,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      onCreated(project);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={create} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>Pick a directory on this device. Threads in the project start their shell there.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="project-path">Directory</Label>
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
              className="h-56 overflow-y-auto rounded-md border bg-background/60 p-1"
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
                  {home && listing.path !== home && (
                    <DirRow icon={<HomeIcon />} label="~" onClick={() => browse(home)} muted />
                  )}
                  {listing.parent !== null && (
                    <DirRow icon={<CornerLeftUpIcon />} label=".." onClick={() => browse(listing.parent!)} muted />
                  )}
                  {listing.dirs.map((d) => (
                    <DirRow key={d} icon={<FolderIcon />} label={d} onClick={() => browse(joinPath(listing.path, d))} />
                  ))}
                  {listing.dirs.length === 0 && (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">No subdirectories.</p>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="project-name">Name (optional)</Label>
            <Input
              id="project-name"
              value={name}
              placeholder={basename(path)}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {error && <p className="text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !path.trim()}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
