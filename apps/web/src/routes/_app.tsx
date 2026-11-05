import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";
import { Alerts } from "@/components/alerts";
import { FleetProvider } from "@/components/fleet";
import { auth } from "@/lib/auth";
import { hub } from "@/lib/hub";
import { syncPushSubscription } from "@/lib/pwa";
import { watchResume } from "@/lib/resume";

// The assistant (its agent, model client and voice) loads on its own, after the app.
const Assistant = lazy(() => import("@/components/assistant/assistant").then((m) => ({ default: m.Assistant })));

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

  return (
    <main className="h-full min-h-0">
      <FleetProvider>
        <Outlet />
        <Alerts />
        <Suspense fallback={null}>
          <Assistant />
        </Suspense>
      </FleetProvider>
    </main>
  );
}
