import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { LoaderIcon, PanelLeftIcon, RotateCcwIcon, WifiOffIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { CenteredMessage } from "@/components/centered-message";
import { DeviceContext, type DeviceContextValue, useDevice } from "@/components/device-context";
import { DeviceSidebar } from "@/components/device-sidebar";
import { Button } from "@/components/ui/button";
import { useDevices } from "@/lib/devices";
import { UNREACHABLE_MESSAGE, usePeer, useRpc } from "@/lib/peer";
import { cn, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/_app/d/$deviceId")({
  component: DeviceLayout,
});

function DeviceLayout() {
  const { deviceId } = Route.useParams();
  const { devices } = useDevices();
  const device = devices?.find((d) => d.id === deviceId);
  const { peer, ...conn } = usePeer(deviceId);
  const info = useRpc(peer, "device.info", {});
  const projects = useRpc(peer, "projects.list", {}, ["projects.changed"]);
  const threads = useRpc(peer, "threads.list", {}, ["threads.changed"]);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close the mobile drawer on navigation within the device.
  const pathname = Route.useMatch({ select: (m) => m.pathname });
  useEffect(() => setSidebarOpen(false), [pathname]);

  if (devices && !device) {
    return (
      <CenteredMessage title="Device not found" body="It may have been removed from your account.">
        <Button variant="outline" size="sm" asChild>
          <Link to="/">Back to devices</Link>
        </Button>
      </CenteredMessage>
    );
  }

  const ctx: DeviceContextValue = { deviceId, device, peer, conn, info, projects, threads };

  return (
    <DeviceContext.Provider value={ctx}>
      <div className="relative flex h-full min-h-0">
        <DeviceSidebar
          className={cn(
            "w-64 shrink-0 max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:shadow-2xl max-md:shadow-black/60",
            !sidebarOpen && "max-md:hidden",
          )}
        />
        {sidebarOpen && (
          <button
            type="button"
            aria-label="Close sidebar"
            className="absolute inset-0 z-20 bg-black/40 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <section className="flex min-w-0 flex-1 flex-col">
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-1.5 left-1.5 z-10 md:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sidebar"
          >
            <PanelLeftIcon />
          </Button>
          {conn.state === "connected" ? <Outlet /> : <ConnectionPanel />}
        </section>
      </div>
    </DeviceContext.Provider>
  );
}

function ConnectionPanel() {
  const { deviceId, device, peer, conn } = useDevice();
  const name = device?.name ?? "this device";

  if (conn.state === "offline") {
    return (
      <Panel icon={<WifiOffIcon className="size-5 text-muted-foreground" />} title="Device offline">
        <p>
          {name}'s daemon isn't connected{device?.lastSeenAt ? ` (last seen ${timeAgo(device.lastSeenAt)})` : ""}. This
          page reconnects on its own when it comes back.
        </p>
        <p>
          On the machine, check it with{" "}
          <code className="rounded bg-terminal px-1 py-0.5 font-mono text-xs text-foreground">everywhere status</code>.
        </p>
      </Panel>
    );
  }

  if (conn.state === "failed") {
    const unreachable = conn.error === UNREACHABLE_MESSAGE;
    return (
      <Panel
        icon={<WifiOffIcon className="size-5 text-destructive" />}
        title={unreachable ? UNREACHABLE_MESSAGE : "Couldn't connect to device"}
        action={
          <Button variant="outline" size="sm" onClick={() => peer.retry()}>
            <RotateCcwIcon />
            Try again
          </Button>
        }
      >
        {unreachable ? (
          <p>
            {name} is online, but no direct connection could be made. Terminals travel peer-to-peer over Tailscale, so
            this browser's machine has to be on the same tailnet as {name}.
          </p>
        ) : (
          <p className="font-mono text-xs">{conn.error}</p>
        )}
      </Panel>
    );
  }

  return (
    <Panel icon={<LoaderIcon className="size-5 animate-spin text-muted-foreground" />} title="Connecting…" key={deviceId}>
      <p>Opening a direct connection to {name}.</p>
    </Panel>
  );
}

function Panel({
  icon,
  title,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {icon}
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <div className="grid gap-2 text-muted-foreground">{children}</div>
        {action}
      </div>
    </div>
  );
}
