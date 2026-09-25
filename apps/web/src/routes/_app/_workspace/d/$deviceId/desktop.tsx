import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useDevice } from "@/components/device-context";

const DesktopView = lazy(() => import("@/components/desktop/desktop-view").then((m) => ({ default: m.DesktopView })));

export const Route = createFileRoute("/_app/_workspace/d/$deviceId/desktop")({
  component: DesktopPage,
});

/** The device's logged-in desktop, streamed and controlled over WebRTC. */
function DesktopPage() {
  const { deviceId, device, peer, info } = useDevice();
  return (
    <Suspense>
      <DesktopView
        key={deviceId}
        peer={peer}
        deviceId={deviceId}
        deviceName={device?.name || info.data?.hostname || "the device"}
      />
    </Suspense>
  );
}
