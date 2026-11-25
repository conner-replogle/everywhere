import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { CenteredMessage } from "@/components/centered-message";
import { ConnectionPanel } from "@/components/connection-panel";
import { DeviceContext } from "@/components/device-context";
import { useFleet } from "@/components/fleet";
import { Button } from "@/components/ui/button";

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
