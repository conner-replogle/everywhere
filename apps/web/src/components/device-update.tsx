import { ArrowUpCircleIcon, LoaderIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useDevice } from "@/components/device-context";
import { useRpc } from "@/lib/peer";

const UPDATE_TIMEOUT_MS = 3 * 60_000; // download + verify on a slow link

/**
 * Offers the latest daemon release when there is one, installs it on
 * request and follows the daemon through its restart.
 */
export function DeviceUpdate() {
  const { device, peer, conn, info } = useDevice();
  const supported = info.data?.features?.includes("update") ?? false;
  const check = useRpc(peer, "device.checkUpdate", {}, [], supported && conn.state === "connected");
  const [confirming, setConfirming] = useState(false);
  // The version the daemon is restarting into, until it's back on it.
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (target && info.data?.version === target) {
      setTarget(null);
      check.refetch();
    }
  }, [target, info.data?.version, check.refetch]);

  if (target) {
    return (
      <div className="flex items-center gap-1.5 px-3 pt-2 text-xs text-muted-foreground">
        <LoaderIcon className="size-3 animate-spin" />
        Restarting into {target}…
      </div>
    );
  }
  const u = check.data;
  if (!u?.available) return null;

  const name = device?.name ?? info.data?.hostname ?? "this device";
  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="mx-2 mt-2 flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-left text-xs text-primary hover:bg-primary/15"
      >
        <ArrowUpCircleIcon className="size-3.5 shrink-0" />
        <span className="flex-1">Update available: {u.latest}</span>
        <span className="text-primary/70">{u.current}</span>
      </button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Update ${name} to ${u.latest}?`}
        confirmLabel="Update and restart"
        description={
          <>
            <p>
              The daemon downloads the release from GitHub, checks it, replaces itself and restarts. You're reconnected
              in a few seconds.
            </p>
            <p>Shells in open terminals are closed. Claude threads resume where they left off.</p>
          </>
        }
        onConfirm={async () => {
          const r = await peer.call("device.update", {}, UPDATE_TIMEOUT_MS);
          setTarget(r.version);
        }}
      />
    </>
  );
}
