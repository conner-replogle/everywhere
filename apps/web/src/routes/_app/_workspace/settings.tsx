import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { MonitorIcon, PaletteIcon, PuzzleIcon, ShieldIcon } from "lucide-react";
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
  { to: "/settings/plugins", label: "Plugins", icon: PuzzleIcon, order: 70 },
];
const SECTIONS = [...CORE, ...pluginSettings()].sort((a, b) => a.order - b.order);

function SettingsLayout() {
  return (
    <div className="h-full overflow-y-auto">
      {/* On phones, below the button that opens the sidebar. */}
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 max-md:pt-14 sm:px-6 md:flex-row md:gap-8">
        <nav aria-label="Settings" className="flex shrink-0 gap-0.5 md:w-40 md:flex-col">
          <span className="hidden px-2 pb-1.5 text-xs font-medium text-muted-foreground md:block">Settings</span>
          {SECTIONS.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className="flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none [&_svg]:size-3.5"
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
