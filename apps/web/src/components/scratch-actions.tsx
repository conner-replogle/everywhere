// Moving work between Scratch and projects: a Scratch thread's folder can
// become a project, and a claude thread can carry on in another project.

import type { Project, Thread } from "@everywhere/protocol";
import { useNavigate } from "@tanstack/react-router";
import { FolderIcon, HomeIcon, MonitorIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { DeviceContextValue } from "@/components/device-context";
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
import { getPrefs } from "@/lib/prefs";
import { cn, errorMessage } from "@/lib/utils";

/** Makes a Scratch thread's folder a project; the thread moves in and carries on there. */
export function PromoteDialog({
  entry,
  thread,
  open,
  onOpenChange,
}: {
  entry: DeviceContextValue;
  thread: Thread;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [name, setName] = useState(thread.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(thread.name);
      setError(null);
      setBusy(false);
    }
  }, [open, thread.name]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await entry.peer.call("threads.promote", { id: thread.id, name: name.trim() });
      entry.projects.refetch();
      entry.threads.refetch();
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
            <DialogTitle>Make this a project</DialogTitle>
            <DialogDescription asChild>
              <div className="grid gap-2">
                <p>
                  The thread&apos;s folder becomes a project and the thread moves into it. Claude carries on in the same
                  folder, and new threads can start there.
                </p>
                {thread.scratchDir && (
                  <code className="block font-mono text-xs break-all text-muted-foreground">{thread.scratchDir}</code>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Project name"
            placeholder="Project name"
          />
          {error && <p className="text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              Make project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Starts a claude thread in another project (or Scratch) with this one's
 * conversation so far. Claude can't change folders mid-conversation, so the
 * thread itself stays where it is.
 */
export function ContinueDialog({
  entry,
  thread,
  open,
  onOpenChange,
  only,
}: {
  entry: DeviceContextValue;
  thread: Thread;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Skip the choice: continue in this project (Scratch, from a project). */
  only?: Project;
}) {
  const navigate = useNavigate();
  const choices = only ? [only] : (entry.projects.data ?? []).filter((p) => p.id !== thread.projectId && !p.isScratch);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setPicked(only?.id ?? null);
      setError(null);
      setBusy(false);
    }
  }, [open, only?.id]);
  const target = choices.find((p) => p.id === picked);

  async function submit() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      // Scratch threads start in auto; elsewhere, the account's default mode.
      const mode = target.isScratch ? undefined : (await getPrefs()).defaultPermissionMode;
      const t = await entry.peer.call("threads.continueIn", {
        id: thread.id,
        projectId: target.id,
        ...(mode ? { permissionMode: mode } : {}),
      });
      entry.threads.refetch();
      onOpenChange(false);
      await navigate({ to: "/d/$deviceId/t/$threadId", params: { deviceId: entry.deviceId, threadId: t.id } });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{only?.isScratch ? "Continue in Scratch" : "Continue in a project"}</DialogTitle>
          <DialogDescription>
            Starts a new Claude thread {only?.isScratch ? "in a fresh Scratch folder" : "there"} that picks up from this
            conversation. Claude can&apos;t move folders mid-conversation, so this thread and its files stay where they
            are.
          </DialogDescription>
        </DialogHeader>
        {!only &&
          (choices.length === 0 ? (
            <p className="text-muted-foreground">There are no other projects on this device yet.</p>
          ) : (
            <ul className="grid max-h-72 gap-px overflow-y-auto" role="radiogroup" aria-label="Project">
              {choices.map((p) => {
                const Icon = p.isHome ? HomeIcon : FolderIcon;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={picked === p.id}
                      onClick={() => setPicked(p.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
                        picked === p.id ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                      )}
                    >
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{p.isHome ? "Home" : p.name}</span>
                      <code className="ml-auto min-w-0 truncate font-mono text-[11px] text-muted-foreground">{p.path}</code>
                    </button>
                  </li>
                );
              })}
            </ul>
          ))}
        {only && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <MonitorIcon className="size-3.5" />
            {only.isScratch ? "Scratch" : only.name}
          </p>
        )}
        {error && <p className="text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || !target} onClick={() => void submit()}>
            Continue there
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
