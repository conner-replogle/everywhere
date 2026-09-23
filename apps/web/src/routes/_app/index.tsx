import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { AddDeviceButton } from "@/components/add-device-dialog";
import { PresenceDot } from "@/components/presence-dot";
import type { Device } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useDevices } from "@/lib/devices";
import { useHub } from "@/lib/hub";
import { cn, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/_app/")({
  component: DeviceList,
});

function DeviceList() {
  const { devices, error } = useDevices();
  const { online, presenceKnown } = useHub();

  const sorted = devices
    ? [...devices].sort((a, b) => Number(online.has(b.id)) - Number(online.has(a.id)) || a.name.localeCompare(b.name))
    : undefined;
  const onlineCount = devices?.filter((d) => online.has(d.id)).length ?? 0;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex items-end gap-3">
        <div>
          <h1 className="text-base font-semibold tracking-tight">Devices</h1>
          {devices && devices.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {presenceKnown ? `${onlineCount} of ${devices.length} online` : `${devices.length} enrolled`}
            </p>
          )}
        </div>
        {sorted?.length !== 0 && (
          <div className="ml-auto">
            <AddDeviceButton />
          </div>
        )}
      </div>

      <TwoFactorBanner />

      {error && !devices && <p className="text-destructive">Couldn't load devices: {error}</p>}

      {sorted === undefined && !error && <ListSkeleton />}

      {sorted?.length === 0 && (
        <div className="rounded-lg border border-dashed px-6 py-12 text-center">
          <p className="font-medium">No devices yet</p>
          <p className="mx-auto mt-1 max-w-sm text-muted-foreground">
            Add a machine with a one-line install. Once its daemon connects, it shows up here and you can open
            terminals on it.
          </p>
          <div className="mt-4">
            <AddDeviceButton />
          </div>
        </div>
      )}

      {sorted && sorted.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-lg border bg-card">
          {sorted.map((d) => (
            <DeviceRow key={d.id} device={d} online={presenceKnown ? online.has(d.id) : undefined} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DeviceRow({ device: d, online }: { device: Device; online: boolean | undefined }) {
  const body = (
    <>
      <PresenceDot online={online} className="mt-[5px]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium">{d.name}</span>
          {d.hostname !== d.name && <span className="truncate font-mono text-xs text-muted-foreground">{d.hostname}</span>}
        </div>
        <div className="mt-0.5 flex gap-3 text-xs text-muted-foreground">
          <span>
            {d.os}/{d.arch}
          </span>
          <span className="font-mono">{d.version}</span>
        </div>
      </div>
      <div className="shrink-0 text-right text-xs">
        {online ? (
          <span className="text-live">Online</span>
        ) : online === false ? (
          <span className="text-muted-foreground">Last seen {timeAgo(d.lastSeenAt)}</span>
        ) : null}
      </div>
    </>
  );

  const row = "flex items-start gap-3 px-4 py-3";
  return (
    <li>
      {online ? (
        <Link
          to="/d/$deviceId"
          params={{ deviceId: d.id }}
          className={cn(
            row,
            "transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
          )}
        >
          {body}
        </Link>
      ) : (
        <div className={cn(row, "cursor-default opacity-50")} aria-disabled title="This device is offline">
          {body}
        </div>
      )}
    </li>
  );
}

function ListSkeleton() {
  return (
    <ul className="divide-y rounded-lg border bg-card" aria-hidden>
      {[0, 1].map((i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-3.5">
          <span className="size-2 rounded-full bg-muted-foreground/20" />
          <span className="h-3 w-40 rounded bg-muted-foreground/10" />
        </li>
      ))}
    </ul>
  );
}

const BANNER_DISMISSED_KEY = "ew:dismissed:2fa-banner";

/** A quiet nudge toward 2FA until it's on or the user says no thanks. */
function TwoFactorBanner() {
  const user = useAuth()?.user;
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(BANNER_DISMISSED_KEY) === "1");
  if (!user || user.totpEnabled || dismissed) return null;
  return (
    <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-primary/20 bg-primary/5 py-2 pr-2 pl-3">
      <ShieldIcon className="size-3.5 shrink-0 text-primary" />
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        <span className="text-foreground">Turn on two-factor authentication.</span> This account can open a shell on
        every device you enroll.{" "}
        <Link to="/settings/security" className="text-primary underline-offset-4 hover:underline">
          Set it up
        </Link>
      </p>
      <button
        type="button"
        onClick={() => {
          localStorage.setItem(BANNER_DISMISSED_KEY, "1");
          setDismissed(true);
        }}
        className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        aria-label="Dismiss"
        title="Dismiss"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
