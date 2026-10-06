import type { UpdateInfo } from "@everywhere/protocol";
import { LoaderIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useDevice } from "@/components/device-context";
import { errorMessage } from "@/lib/utils";

const UPDATE_TIMEOUT_MS = 3 * 60_000; // download + verify on a slow link
const RECHECK_MS = 15 * 60_000;

export interface UpdateCheck {
  /** The daemon can update itself (and so can be asked about updates). */
  supported: boolean;
  data: UpdateInfo | undefined;
  /** Why the last check failed, if it did. */
  error: string | null;
  checking: boolean;
  /** force skips the daemon's cached lookup of the latest release. */
  check: (force?: boolean) => void;
}

/**
 * Asks the daemon whether a newer release exists: on connect, when the tab
 * comes back into view, every so often, and on demand.
 */
export function useUpdateCheck(): UpdateCheck {
  const { peer, conn, info } = useDevice();
  const supported = info.data?.features?.includes("update") ?? false;
  const enabled = supported && conn.state === "connected";
  const [data, setData] = useState<UpdateInfo>();
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(
    (force = false) => {
      setChecking(true);
      peer
        .call("device.checkUpdate", force ? { force: true } : {})
        .then((d) => {
          setData(d);
          setError(null);
        })
        // Keep what we had; the refresh button shows why.
        .catch((e: unknown) => setError(errorMessage(e)))
        .finally(() => setChecking(false));
    },
    [peer],
  );

  useEffect(() => {
    if (!enabled) return;
    check();
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = setInterval(check, RECHECK_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      clearInterval(timer);
    };
  }, [enabled, conn.generation, check]);

  return { supported, data, error, checking, check };
}

/** What the device menu says about the daemon's version, for its "Check for updates" item. */
export function updateStatus(update: UpdateCheck): string | undefined {
  if (update.checking) return "Checking…";
  if (update.error) return `Couldn't check: ${update.error}`;
  if (update.data?.reason) return `${update.data.reason} Updates are off.`;
  if (update.data && !update.data.available) return `Up to date (${update.data.latest})`;
  return undefined;
}

/**
 * Confirms installing the latest daemon release (opened from the device
 * menu), installs it and follows the daemon through its restart.
 */
export function DeviceUpdate({
  update,
  open,
  onOpenChange,
}: {
  update: UpdateCheck;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { device, peer, info } = useDevice();
  // The version the daemon is restarting into, until it's back on it.
  const [target, setTarget] = useState<string | null>(null);
  const { check } = update;

  useEffect(() => {
    if (target && info.data?.version === target) {
      setTarget(null);
      check();
    }
  }, [target, info.data?.version, check]);

  if (target) {
    return (
      <div className="flex items-center gap-1.5 px-3 pt-2 text-xs text-muted-foreground">
        <LoaderIcon className="size-3 animate-spin" />
        Restarting into {target}…
      </div>
    );
  }
  const u = update.data;
  if (!u?.available) return null;

  const name = device?.name ?? info.data?.hostname ?? "this device";
  return (
    <>
      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
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
