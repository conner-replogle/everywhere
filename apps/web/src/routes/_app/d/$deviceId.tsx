import { createFileRoute, Link, Outlet, useLocation, useParams } from "@tanstack/react-router";
import { LoaderIcon, PanelLeftIcon, RotateCcwIcon, WifiOffIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { CenteredMessage } from "@/components/centered-message";
import { DebugPanel, useDebugPanelState } from "@/components/debug-panel";
import { DeviceContext, type DeviceContextValue, useDevice } from "@/components/device-context";
import { DeviceSidebar } from "@/components/device-sidebar";
import { Button } from "@/components/ui/button";
import { useDevices } from "@/lib/devices";
import { NO_ANSWER_MESSAGE, UNREACHABLE_MESSAGE, usePeer, useRpc } from "@/lib/peer";
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
  const [debugOpen, setDebugOpen] = useDebugPanelState();

  // Close the mobile drawer on navigation within the device.
  const pathname = useLocation({ select: (l) => l.pathname });
  useEffect(() => setSidebarOpen(false), [pathname]);
  // On phones the device home is the project list itself, not an empty page behind a drawer.
  const atHome = !useParams({ strict: false }).threadId;
  const sidebarAsPage = atHome && conn.state === "connected";

  if (devices && !device) {
    return (
      <CenteredMessage title="Device not found" body="It may have been removed from your account.">
        <Button variant="outline" size="sm" asChild>
          <Link to="/">Back to devices</Link>
        </Button>
      </CenteredMessage>
    );
  }

  const ctx: DeviceContextValue = { deviceId, device, peer, conn, info, projects, threads, debugOpen, setDebugOpen };

  return (
    <DeviceContext.Provider value={ctx}>
      <div className="relative flex h-full min-h-0">
        <DeviceSidebar
          className={cn(
            "w-64 shrink-0",
            sidebarAsPage
              ? "max-md:w-full max-md:border-r-0"
              : "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:w-[min(20rem,85%)] max-md:shadow-2xl max-md:shadow-black/60",
            !sidebarOpen && !sidebarAsPage && "max-md:hidden",
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
        <section className={cn("flex min-w-0 flex-1 flex-col", sidebarAsPage && "max-md:hidden")}>
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
        {debugOpen && (
          <DebugPanel
            onClose={() => setDebugOpen(false)}
            className="w-[380px] shrink-0 max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:shadow-2xl max-lg:shadow-black/60 max-sm:w-full"
          />
        )}
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
    const noAnswer = conn.error === NO_ANSWER_MESSAGE;
    return (
      <Panel
        icon={<WifiOffIcon className="size-5 text-destructive" />}
        title={unreachable ? UNREACHABLE_MESSAGE : noAnswer ? NO_ANSWER_MESSAGE : "Couldn't connect to device"}
        action={
          <Button variant="outline" size="sm" onClick={() => peer.retry()}>
            <RotateCcwIcon />
            Try again
          </Button>
        }
      >
        {noAnswer ? (
          <p>
            {name} looks online, but its daemon never answered. It may have lost its network and not noticed yet; it
            reconnects on its own within about half a minute. If this keeps happening, check it with{" "}
            <code className="rounded bg-terminal px-1 py-0.5 font-mono text-xs text-foreground">everywhere status</code>{" "}
            on the machine.
          </p>
        ) : unreachable ? (
          <p>
            {name} is online, but no connection could be made, neither direct (LAN, Tailscale) nor through the TURN
            relay. Open the debug panel for details.
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
