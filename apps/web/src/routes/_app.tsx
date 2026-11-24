import { createFileRoute, Outlet, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Alerts } from "@/components/alerts";
import { BugReport } from "@/components/bug-report";
import { FleetProvider } from "@/components/fleet";
import { auth } from "@/lib/auth";
import { hub } from "@/lib/hub";
import { syncPushSubscription } from "@/lib/pwa";
import { watchResume } from "@/lib/resume";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    const me = await auth.load();
    if (!me.user) {
      if (me.signupOpen) throw redirect({ to: "/signup" });
      throw redirect({ to: "/login", search: location.href === "/" ? {} : { redirect: location.href } });
    }
    return { user: me.user };
  },
  component: AppLayout,
});

function AppLayout() {
  const navigate = useNavigate();

  useEffect(() => {
    hub.onUnauthorized = () => {
      auth.clear();
      void navigate({ to: "/login" });
    };
    hub.start();
    syncPushSubscription().catch((err) => console.warn("push subscription:", err));
    const stopWatching = watchResume();
    return () => {
      hub.onUnauthorized = null;
      stopWatching();
    };
  }, [navigate]);

  // A popped-out window shows one device: it connects to that one alone, and shows nothing but its view.
  const popout = useLocation({ select: (l) => /^\/popout\/d\/([^/]+)/.exec(l.pathname)?.[1] });
  if (popout) {
    return (
      <main className="h-full min-h-0">
        <FleetProvider only={decodeURIComponent(popout)}>
          <Outlet />
        </FleetProvider>
      </main>
    );
  }

  return (
    <main className="h-full min-h-0">
      <FleetProvider>
        <Outlet />
        <Alerts />
        <BugReport />
      </FleetProvider>
    </main>
  );
}
