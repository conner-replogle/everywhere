import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { PanelLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { DebugPanel, useDebugPanelState } from "@/components/debug-panel";
import { DeviceContext } from "@/components/device-context";
import { useFleet } from "@/components/fleet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/_workspace")({
  component: WorkspaceLayout,
});

/** Projects and threads from every device in one sidebar, beside the open thread. */
function WorkspaceLayout() {
  const { entries } = useFleet();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [debugDevice, setDebugDevice] = useDebugPanelState();
  const debugEntry = debugDevice ? entries.get(debugDevice) : undefined;

  // Close the mobile drawer on navigation.
  const pathname = useLocation({ select: (l) => l.pathname });
  useEffect(() => setSidebarOpen(false), [pathname]);
  // On phones the home page is the sidebar itself, not an empty page behind a drawer.
  const sidebarAsPage = pathname === "/";

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
      <AppSidebar
        debugDevice={debugDevice}
        onDebug={(id) => setDebugDevice(debugDevice === id ? null : id)}
        className={cn(
          "w-72 shrink-0",
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
      <section className={cn("relative flex min-w-0 flex-1 flex-col", sidebarAsPage && "max-md:hidden")}>
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-1.5 left-1.5 z-10 md:hidden"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open sidebar"
        >
          <PanelLeftIcon className="size-5" />
        </Button>
        <Outlet />
      </section>
      {debugEntry && (
        <DeviceContext.Provider value={debugEntry}>
          <DebugPanel
            onClose={() => setDebugDevice(null)}
            className="w-[380px] shrink-0 max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:shadow-2xl max-lg:shadow-black/60 max-sm:w-full"
          />
        </DeviceContext.Provider>
      )}
    </div>
  );
}
