import type { UpdateInfo } from "@everywhere/protocol";
import { ArrowUpCircleIcon, LoaderIcon, RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useDevice } from "@/components/device-context";
import { cn, errorMessage } from "@/lib/utils";

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

/** The small button next to the version: re-read the device and look for a release now. */
export function RefreshVersionButton({ update, onRefresh }: { update: UpdateCheck; onRefresh?: () => void }) {
  const { info } = useDevice();
  const upToDate = update.data && !update.data.available && !update.data.reason;
  return (
    <button
      type="button"
      onClick={() => {
        info.refetch();
        if (update.supported) update.check(true);
        onRefresh?.();
      }}
      disabled={update.checking}
      className={cn(
        "shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60",
        update.error && "text-warn",
      )}
      aria-label="Check for updates"
      title={
        update.checking
          ? "Checking for updates…"
          : update.error
            ? `Couldn't check for updates: ${update.error}`
            : update.data?.reason
              ? `${update.data.reason} Updates are off.`
              : upToDate
                ? `Up to date (latest is ${update.data?.latest}). Click to check again.`
                : "Check for updates"
      }
    >
      <RotateCwIcon className={cn("size-3", update.checking && "animate-spin")} />
    </button>
  );
}

/**
 * Offers the latest daemon release when there is one, installs it on
 * request and follows the daemon through its restart.
 */
export function DeviceUpdate({ update }: { update: UpdateCheck }) {
  const { device, peer, info } = useDevice();
  const [confirming, setConfirming] = useState(false);
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
