import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { useFleet } from "@/components/fleet";
import { PluginView } from "@/plugins/external";

/** An installed plugin's own settings page: its web part's settings view, in its sandboxed frame. */
export const Route = createFileRoute("/_app/_workspace/settings/plugins_/$deviceId/$pluginId")({
  component: PluginSettingsPage,
});

function PluginSettingsPage() {
  const { deviceId, pluginId } = Route.useParams();
  const entry = useFleet().entries.get(deviceId);
  const plugin = entry?.info.data?.plugins?.find((p) => p.id === pluginId);
  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-96 flex-col gap-3">
      <Link to="/settings/plugins" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronLeftIcon className="size-3.5" />
        Plugins
      </Link>
      {!entry || entry.conn.state !== "connected" ? (
        <p className="text-xs text-muted-foreground">Connect to the device to change this plugin's settings.</p>
      ) : !plugin?.settingsPage ? (
        <p className="text-xs text-muted-foreground">This device has no plugin {pluginId} with a settings page.</p>
      ) : (
        <>
          <h1 className="text-base font-semibold tracking-tight">{plugin.title}</h1>
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
            <PluginView
              plugin={plugin}
              host={{
                peer: entry.peer,
                generation: entry.conn.generation,
                view: "settings",
                pane: { id: "settings", kind: "settings", name: "Settings" },
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
