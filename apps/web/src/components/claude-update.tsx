import type { ClaudeVersion } from "@everywhere/protocol";
import { ArrowUpCircleIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDevice } from "@/components/device-context";

const UPDATE_TIMEOUT_MS = 6 * 60_000; // the daemon allows the updater 5 minutes

export interface ClaudeUpdateCheck {
  data: ClaudeVersion | undefined;
  /** force skips the daemon's cached lookup of the newest release. */
  check: (force?: boolean) => void;
}

/**
 * Asks the daemon whether a newer Claude Code exists: on connect, when the
 * tab comes back into view, and on demand.
 */
export function useClaudeUpdateCheck(): ClaudeUpdateCheck {
  const { peer, conn, info } = useDevice();
  const enabled = conn.state === "connected" && !!info.data?.features?.includes("claudeUpdate");
  const [data, setData] = useState<ClaudeVersion>();

  const check = useCallback(
    (force = false) => {
      peer
        .call("agent.claudeVersion", force ? { force: true } : {})
        .then(setData)
        // No claude here, or the registry is unreachable: nothing to offer.
        .catch(() => {});
    },
    [peer],
  );

  useEffect(() => {
    if (!enabled) return;
    check();
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled, conn.generation, check]);

  return { data: enabled ? data : undefined, check };
}

/**
 * Offers the newest Claude Code when the device's is behind, and runs its
 * installer's update on request. An install the daemon can't attribute to an
 * installer is left to the user, with what to run.
 */
export function ClaudeUpdate({ update }: { update: ClaudeUpdateCheck }) {
  const { device, peer, info } = useDevice();
  const [open, setOpen] = useState(false);
  const u = update.data;
  if (!u?.available) return null;

  const name = device?.name ?? info.data?.hostname ?? "this device";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mx-2 mt-2 flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-left text-xs text-primary hover:bg-primary/15"
      >
        <ArrowUpCircleIcon className="size-3.5 shrink-0" />
        <span className="flex-1">Claude Code update: {u.latest}</span>
        <span className="text-primary/70">{u.current}</span>
      </button>
      {u.canUpdate ? (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title={`Update Claude Code on ${name} to ${u.latest}?`}
          confirmLabel="Update"
          description={
            <>
              <p>
                The device runs <code className="font-mono text-xs">{u.command}</code>.
              </p>
              <p>Claude threads switch to the new version when they're next idle, and pick up where they left off.</p>
            </>
          }
          onConfirm={async () => {
            await peer.call("agent.updateClaude", {}, UPDATE_TIMEOUT_MS);
            update.check(true);
          }}
        />
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Claude Code {u.latest} is out</DialogTitle>
              <DialogDescription asChild>
                <div className="grid gap-2">
                  <p>
                    {name} has {u.current}, at <code className="font-mono text-xs break-all">{u.path}</code>. It wasn't
                    installed in a way the daemon can update, so update it the way you installed it.
                  </p>
                  <p>Claude threads switch to the new version when they're next idle.</p>
                </div>
              </DialogDescription>
            </DialogHeader>
            <Button variant="ghost" className="justify-self-end" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
