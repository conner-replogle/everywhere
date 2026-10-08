import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRightIcon, MonitorIcon, ShieldIcon, SparklesIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { AddDeviceButton } from "@/components/add-device-dialog";
import type { DeviceContextValue } from "@/components/device-context";
import { useFleet } from "@/components/fleet";
import { PresenceDot } from "@/components/presence-dot";
import { deviceName, ScratchComposer, scratchProject, scratchThreads } from "@/components/scratch";
import { useAuth } from "@/lib/auth";
import { useDeviceOnline } from "@/lib/hub";

export const Route = createFileRoute("/_app/_workspace/")({
  component: Home,
});

function Home() {
  const { devices, error, entries } = useFleet();
  const list = [...entries.values()];
  // Until every connected daemon has said whether it has Scratch, assume it does.
  const loading = list.some((e) => e.conn.state === "connecting" || (e.conn.state === "connected" && !e.projects.data));
  if (devices && devices.length > 0 && (loading || list.some((e) => !!scratchProject(e)))) {
    return <Launcher entries={list} />;
  }
  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-xl px-4 pt-6">
        <TwoFactorBanner />
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-2 text-center">
          {error && !devices ? (
            <p className="text-destructive">Couldn't load devices: {error}</p>
          ) : devices?.length === 0 ? (
            <>
              <h2 className="text-[15px] font-semibold">No devices yet</h2>
              <p className="text-muted-foreground">
                Add a machine with a one-line install. Once its daemon connects, its projects show up in the sidebar.
              </p>
              <div className="mt-2">
                <AddDeviceButton />
              </div>
            </>
          ) : (
            <>
              <SparklesIcon className="size-6 text-muted-foreground" />
              <h2 className="text-[15px] font-semibold">Pick a thread</h2>
              <p className="text-muted-foreground">
                Projects from all your devices are in the sidebar. Press + on a project to start a terminal or a Claude
                thread in it.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
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

/** Start something on any device, or open one. */
function Launcher({ entries }: { entries: DeviceContextValue[] }) {
  const sorted = [...entries].sort((a, b) => deviceName(a).localeCompare(deviceName(b)));
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto grid w-full max-w-xl grid-cols-[minmax(0,1fr)] gap-6 px-4 pt-14 pb-10 md:pt-[12vh]">
        <TwoFactorBanner />
        <div className="grid gap-3">
          <div className="grid gap-0.5">
            <h1 className="text-[15px] font-semibold">What do you need done?</h1>
            <p className="text-xs text-muted-foreground">
              Starts a Scratch thread, in a fresh folder on the device you pick. For code, open a project in the
              sidebar.
            </p>
          </div>
          <ScratchComposer entries={sorted.filter((e) => !!scratchProject(e) || e.conn.state !== "connected")} autoFocus />
        </div>
        <section className="grid gap-1.5" aria-labelledby="devices-heading">
          <h2 id="devices-heading" className="text-xs font-medium text-muted-foreground">
            Devices
          </h2>
          <ul className="grid gap-px">
            {sorted.map((e) => (
              <DeviceCard key={e.deviceId} entry={e} />
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function DeviceCard({ entry }: { entry: DeviceContextValue }) {
  const online = useDeviceOnline(entry.deviceId);
  const live = entry.conn.state === "connected";
  const recent = scratchThreads(entry)[0];
  const status = live
    ? recent
      ? `Last Scratch thread: ${recent.name}`
      : (entry.info.data && `${entry.info.data.os}/${entry.info.data.arch}`) || "Connected"
    : entry.conn.state === "offline"
      ? "Offline"
      : entry.conn.state === "failed"
        ? "Unreachable"
        : "Connecting…";
  return (
    <li>
      <Link
        to="/d/$deviceId"
        params={{ deviceId: entry.deviceId }}
        className="flex h-10 items-center gap-2.5 rounded-md px-2 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
      >
        <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
        <PresenceDot online={online} />
        <span className="truncate">{deviceName(entry)}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{status}</span>
        <ChevronRightIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}
