import type { PluginInfo } from "@everywhere/protocol";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLinkIcon, PuzzleIcon, SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";
import type { DeviceContextValue } from "@/components/device-context";
import { useFleet } from "@/components/fleet";
import { PluginSettingsForm } from "@/components/plugin-settings-form";
import { Section } from "@/components/settings-section";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_app/_workspace/settings/plugins")({
  component: PluginSettings,
});

/** What a permission lets a plugin do, in words. */
const PERMISSIONS: Record<string, string> = {
  "fs.read": "read files",
  "fs.write": "write files",
  exec: "run commands",
  pty: "run terminals",
  "net.loopback": "listen on this machine",
  "agent.tools": "give Claude tools",
  "agent.notify": "message Claude",
  "agent.read": "read Claude threads",
  "agent.launch": "change how Claude starts",
  browser: "drive the device's browser",
  screen: "see and control the screen",
  secrets: "use account secrets",
  remote: "be used by connected agents",
};

function PluginSettings() {
  const { devices, entries } = useFleet();
  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-base font-semibold tracking-tight">Plugins</h1>
        <p className="text-xs text-muted-foreground">
          What each device runs. Built-in plugins come with the daemon; others are installed on the device itself, with{" "}
          <code className="font-mono">everywhere plugin install</code>, so a web session can't add code to a machine.
        </p>
      </div>
      {devices?.map((d) => {
        const info = entries.get(d.id)?.info.data;
        return (
          <Section
            key={d.id}
            title={d.name || info?.hostname || d.hostname}
            description={info ? `${info.os}/${info.arch} · ${info.version}` : "Offline"}
          >
            {!info ? (
              <p className="text-xs text-muted-foreground">Connect to the device to see its plugins.</p>
            ) : !info.plugins ? (
              <p className="text-xs text-muted-foreground">This device's daemon is from before plugins; update it to see them.</p>
            ) : (
              <ul className="grid gap-3">
                {info.plugins.map((p) => (
                  <PluginRow key={p.id} plugin={p} entry={entries.get(d.id)!} />
                ))}
              </ul>
            )}
          </Section>
        );
      })}
    </div>
  );
}

function PluginRow({ plugin: p, entry }: { plugin: PluginInfo; entry: DeviceContextValue }) {
  const [open, setOpen] = useState(false);
  const hasSettings = !!p.settings?.length;
  const c = p.contributes;
  const serves = [
    c.kinds?.length ? `${c.kinds.map((k) => k.kind).join(", ")} tabs` : "",
    c.tools?.length ? `${c.tools.length} tool${c.tools.length === 1 ? "" : "s"} for Claude` : "",
    c.sessions?.length ? `${c.sessions.join(", ")} sessions` : "",
    c.rpc?.length ? `${c.rpc.length} method${c.rpc.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return (
    <li className="flex gap-3 text-sm">
      <PuzzleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{p.title}</span>
          <span className="font-mono text-xs text-muted-foreground">{p.id}</span>
          {p.version && <span className="text-xs text-muted-foreground">{p.version}</span>}
          <span className="rounded-sm bg-muted px-1 text-[10px] text-muted-foreground">{p.builtin ? "built-in" : "installed"}</span>
        </div>
        {!!p.permissions?.length && (
          <p className="text-xs text-muted-foreground">
            Can {p.permissions.map((x) => PERMISSIONS[x] ?? x).join(", ")}.
          </p>
        )}
        {serves.length > 0 && <p className="text-xs text-muted-foreground">Adds {serves.join(" · ")}.</p>}
        {(hasSettings || p.settingsPage) && (
          <div className="mt-1 flex flex-wrap gap-2">
            {hasSettings && (
              <Button variant="outline" size="sm" className="h-6" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                <SlidersHorizontalIcon />
                Settings
              </Button>
            )}
            {p.settingsPage && (
              <Button variant="outline" size="sm" className="h-6" asChild>
                <Link to="/settings/plugins/$deviceId/$pluginId" params={{ deviceId: entry.deviceId, pluginId: p.id }}>
                  <ExternalLinkIcon />
                  More settings
                </Link>
              </Button>
            )}
          </div>
        )}
        {open && (
          <div className="mt-2 max-w-md rounded-md border p-3">
            <PluginSettingsForm peer={entry.peer} plugin={p} />
          </div>
        )}
      </div>
    </li>
  );
}
