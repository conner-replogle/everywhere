import type { DesktopSource } from "@everywhere/protocol";
import { createFileRoute } from "@tanstack/react-router";
import { LoaderIcon, WifiOffIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { CenteredMessage } from "@/components/centered-message";
import { DeviceContext } from "@/components/device-context";
import { useFleet } from "@/components/fleet";
import { SHOW_MESSAGE } from "@/lib/desktop/popout";

const DesktopView = lazy(() => import("@/components/desktop/desktop-view").then((m) => ({ default: m.DesktopView })));

interface Search {
  /** The desktop tab this window was popped out of; without one, the Remote desktop page. */
  tab?: string;
  /** That tab's state when it popped out: what it shows. */
  state?: string;
}

export const Route = createFileRoute("/_app/popout/d/$deviceId/desktop")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
    state: typeof s.state === "string" ? s.state : undefined,
  }),
  component: PopoutDesktop,
});

/** A device's desktop in a window of its own, popped out of the app. */
function PopoutDesktop() {
  const { deviceId } = Route.useParams();
  const { tab, state } = Route.useSearch();
  const { devices, entries } = useFleet();
  const entry = entries.get(deviceId);
  const name = entry?.device.name || entry?.info.data?.hostname || "the device";

  useEffect(() => {
    document.title = `${name} · Remote desktop`;
  }, [name]);

  // What the thread's agent opens, sent on by the tab this came out of.
  const [show, setShow] = useState<{ source: DesktopSource; at: number } | undefined>();
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== window.opener) return;
      const m = e.data as { type?: unknown; source?: DesktopSource } | null;
      if (m?.type === SHOW_MESSAGE && m.source) setShow({ source: m.source, at: Date.now() });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (devices && !entry && !devices.some((d) => d.id === deviceId)) {
    return <CenteredMessage title="Device not found" body="It may have been removed from your account." />;
  }
  if (!entry || entry.conn.state !== "connected") {
    const offline = entry?.conn.state === "offline" || entry?.conn.state === "failed";
    return (
      <CenteredMessage
        title={offline ? `${name} isn't reachable` : `Connecting to ${name}…`}
        body={offline ? "This window reconnects on its own when it comes back." : undefined}
      >
        {offline ? (
          <WifiOffIcon className="size-5 text-muted-foreground" />
        ) : (
          <LoaderIcon className="size-5 animate-spin text-muted-foreground" />
        )}
      </CenteredMessage>
    );
  }

  const { peer } = entry;
  return (
    <DeviceContext.Provider value={entry}>
      <Suspense>
        <DesktopView
          peer={peer}
          deviceId={deviceId}
          deviceName={name}
          popout
          show={show}
          tab={
            tab
              ? {
                  id: tab,
                  state,
                  onStateChange: (s) => void peer.call("tabs.setState", { id: tab, state: s }).catch(() => {}),
                }
              : undefined
          }
        />
      </Suspense>
    </DeviceContext.Provider>
  );
}
