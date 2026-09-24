import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { LoaderIcon, RotateCcwIcon, WifiOffIcon } from "lucide-react";
import { CenteredMessage } from "@/components/centered-message";
import { DeviceContext, useDevice } from "@/components/device-context";
import { useFleet } from "@/components/fleet";
import { Button } from "@/components/ui/button";
import { NO_ANSWER_MESSAGE, UNREACHABLE_MESSAGE } from "@/lib/peer";
import { timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/_app/_workspace/d/$deviceId")({
  component: DeviceLayout,
});

/** Gives the routes under it their device's connection and data, from the fleet. */
function DeviceLayout() {
  const { deviceId } = Route.useParams();
  const { devices, entries } = useFleet();
  const entry = entries.get(deviceId);

  if (devices && !devices.some((d) => d.id === deviceId)) {
    return (
      <CenteredMessage title="Device not found" body="It may have been removed from your account.">
        <Button variant="outline" size="sm" asChild>
          <Link to="/">Back to projects</Link>
        </Button>
      </CenteredMessage>
    );
  }
  if (!entry) return null;

  return (
    <DeviceContext.Provider value={entry}>
      {entry.conn.state === "connected" ? <Outlet /> : <ConnectionPanel />}
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
