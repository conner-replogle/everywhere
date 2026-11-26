import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { MonitorIcon, PaletteIcon, PlugZapIcon, PuzzleIcon, ShieldIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { pluginSettings } from "@/plugins/registry";
import type { SettingsSection } from "@/plugins/types";

export const Route = createFileRoute("/_app/_workspace/settings")({
  component: SettingsLayout,
});

// The core's pages; plugins add theirs (Claude, Notifications, GitHub…).
const CORE: SettingsSection[] = [
  { to: "/settings/devices", label: "Devices", icon: MonitorIcon, order: 10 },
  { to: "/settings/appearance", label: "Appearance", icon: PaletteIcon, order: 40 },
  { to: "/settings/security", label: "Security", icon: ShieldIcon, order: 60 },
  { to: "/settings/agents", label: "Connected agents", icon: PlugZapIcon, order: 65 },
  { to: "/settings/plugins", label: "Plugins", icon: PuzzleIcon, order: 70 },
];
const SECTIONS = [...CORE, ...pluginSettings()].sort((a, b) => a.order - b.order);

function SettingsLayout() {
  const nav = useRef<HTMLElement>(null);
  const path = useRouterState({ select: (s) => s.location.pathname });
  // On phones the row scrolls sideways: keep the open page's link in it.
  useEffect(() => {
    const row = nav.current;
    const link = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !link || row.scrollWidth <= row.clientWidth) return;
    row.scrollTo({ left: link.offsetLeft - (row.clientWidth - link.offsetWidth) / 2, behavior: "smooth" });
  }, [path]);
  return (
    <div className="h-full overflow-y-auto">
      {/* On phones, below the button that opens the sidebar. */}
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 max-md:pt-14 sm:px-6 md:flex-row md:gap-8">
        {/* On phones a row that scrolls sideways, edge to edge, keeping the open page in view. */}
        <nav
          ref={nav}
          aria-label="Settings"
          className="relative -mx-4 flex shrink-0 gap-0.5 overflow-x-auto px-4 [scrollbar-width:none] sm:-mx-6 sm:px-6 md:mx-0 md:w-40 md:flex-col md:overflow-visible md:px-0"
        >
          <span className="hidden px-2 pb-1.5 text-xs font-medium text-muted-foreground md:block">Settings</span>
          {SECTIONS.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className="flex h-7 shrink-0 items-center gap-2 rounded-md px-2 whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none [&_svg]:size-3.5"
              activeProps={{ className: "bg-accent text-foreground" }}
            >
              <Icon />
              {label}
            </Link>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
