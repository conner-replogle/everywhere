import type { CatalogPlugin, InstalledPlugin, PluginCatalog, PluginInfo, PluginManifest } from "@everywhere/protocol";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  DownloadIcon,
  ExternalLinkIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DeviceContextValue } from "@/components/device-context";
import { useFleet } from "@/components/fleet";
import { PluginLogo } from "@/components/kind-icon";
import { PluginSettingsForm } from "@/components/plugin-settings-form";
import { Section } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { Device } from "@/lib/api";
import { cn, errorMessage } from "@/lib/utils";

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

const INSTALL_TIMEOUT = 5 * 60_000;

function deviceName(d: Device, entry: DeviceContextValue | undefined) {
  return d.name || entry?.info.data?.hostname || d.hostname;
}

function PluginSettings() {
  const [tab, setTab] = useState<"browse" | "installed">("browse");
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold tracking-tight">Plugins</h1>
          <p className="text-xs text-muted-foreground">
            Add plugins to your devices from everywhere's registry. Built-in plugins come with the daemon; plugins from elsewhere are
            installed on the device, with <code className="font-mono">everywhere plugin install DIR</code>.
          </p>
        </div>
        <div className="flex rounded-md border p-0.5 text-xs" role="tablist">
          {(["browse", "installed"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn("rounded-sm px-2.5 py-1 capitalize", tab === t ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      {tab === "browse" ? <Browse /> : <Installed />}
    </div>
  );
}

// --- the registry, per device ------------------------------------------------------

interface DeviceCatalog {
  data?: PluginCatalog;
  error?: string;
  loading?: boolean;
}

/** Every connected device's view of the registry, asked again when its plugins change. */
function useCatalogs() {
  const { entries } = useFleet();
  const [catalogs, setCatalogs] = useState<Record<string, DeviceCatalog>>({});
  const connected = [...entries.values()].filter((e) => e.conn.state === "connected" && e.info.data?.plugins);
  const key = connected.map((e) => `${e.deviceId}:${e.conn.generation}`).join(",");

  const load = useCallback((e: DeviceContextValue, fresh = false) => {
    setCatalogs((c) => ({ ...c, [e.deviceId]: { ...c[e.deviceId], loading: true } }));
    (e.peer.callPlugin("plugins.catalog", { fresh }, 60_000) as Promise<PluginCatalog>).then(
      (data) => setCatalogs((c) => ({ ...c, [e.deviceId]: { data } })),
      (err: unknown) => {
        const msg = errorMessage(err);
        setCatalogs((c) => ({
          ...c,
          [e.deviceId]: { error: /unknown method|no such method|plugins\.catalog/i.test(msg) ? "Update everywhere on this device to add plugins" : msg },
        }));
      },
    );
  }, []);

  useEffect(() => {
    const offs = connected.map((e) => {
      load(e);
      return e.peer.onEvent((ev) => {
        if ((ev as { event?: string }).event === "plugins.changed") load(e);
      });
    });
    return () => offs.forEach((off) => off());
    // The connected devices are in key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load]);

  const refresh = () => connected.forEach((e) => load(e, true));
  return { catalogs, refresh };
}

interface Listing {
  plugin: CatalogPlugin;
  /** Each device's view of it, by device id. */
  devices: Map<string, CatalogPlugin>;
}

type Target = { device: Device; entry: DeviceContextValue };

function Browse() {
  const { devices, entries } = useFleet();
  const { catalogs, refresh } = useCatalogs();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<Record<string, string>>({}); // `${plugin}\0${device}` → what's happening
  const [confirm, setConfirm] = useState<{ plugin: CatalogPlugin; targets: Target[]; update: boolean }>();

  const listings = useMemo(() => {
    const byId = new Map<string, Listing>();
    for (const [deviceId, c] of Object.entries(catalogs)) {
      for (const p of c.data?.plugins ?? []) {
        const l = byId.get(p.manifest.id) ?? { plugin: p, devices: new Map() };
        l.devices.set(deviceId, p);
        byId.set(p.manifest.id, l);
      }
    }
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return [...byId.values()]
      .filter(({ plugin: { manifest: m } }) => {
        const hay = [m.id, m.title, m.description, ...(m.contributes.tools ?? []).map((t) => t.title ?? t.name)].join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => a.plugin.manifest.title.localeCompare(b.plugin.manifest.title));
  }, [catalogs, q]);

  const loading = Object.values(catalogs).some((c) => c.loading && !c.data);
  const errors = Object.entries(catalogs).filter(([, c]) => c.error);
  const anyData = Object.values(catalogs).some((c) => c.data);

  const install = async (plugin: CatalogPlugin, targets: Target[]) => {
    const id = plugin.manifest.id;
    await Promise.all(
      targets.map(async ({ device, entry }) => {
        const k = `${id}\0${device.id}`;
        setBusy((b) => ({ ...b, [k]: "Installing…" }));
        try {
          await entry.peer.callPlugin("plugins.install", { id }, INSTALL_TIMEOUT);
          setBusy(({ [k]: _, ...b }) => b);
        } catch (e) {
          setBusy((b) => ({ ...b, [k]: errorMessage(e) }));
        }
      }),
    );
  };

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search plugins" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button variant="outline" size="icon" title="Check the registry again" onClick={refresh}>
          <RefreshCwIcon className={cn(loading && "animate-spin")} />
        </Button>
      </div>
      {errors.length > 0 && (
        <ul className="grid gap-1 text-xs text-muted-foreground">
          {errors.map(([id, c]) => {
            const d = devices?.find((d) => d.id === id);
            return <li key={id}>{d ? deviceName(d, entries.get(id)) : id}: {c.error}</li>;
          })}
        </ul>
      )}
      {!anyData && !errors.length && (
        <p className="py-6 text-center text-xs text-muted-foreground">
          {loading || entries.size ? "Loading the registry…" : "Connect to a device to browse plugins."}
        </p>
      )}
      {anyData && listings.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">No plugins match.</p>}
      {listings.map((l) => (
        <PluginCard
          key={l.plugin.manifest.id}
          listing={l}
          devices={devices ?? []}
          busy={busy}
          onInstall={(targets, update) => setConfirm({ plugin: l.plugin, targets, update })}
        />
      ))}
      <ConfirmInstall
        state={confirm}
        onClose={() => setConfirm(undefined)}
        onConfirm={() => {
          if (confirm) void install(confirm.plugin, confirm.targets);
          setConfirm(undefined);
        }}
      />
    </div>
  );
}

/** How a plugin stands on a device, in a word. */
function standing(view: CatalogPlugin | undefined, entry: DeviceContextValue | undefined, catalogError?: string) {
  if (!entry || entry.conn.state !== "connected") return { text: "Offline", can: false };
  if (catalogError) return { text: catalogError, can: false };
  if (!view) return { text: "…", can: false };
  if (view.problem) return { text: view.problem, can: false };
  if (view.update) return { text: `Update to ${view.manifest.version}`, can: true, update: true };
  if (view.installed) return { text: view.enabled ? `Installed ${view.installed}` : `Installed ${view.installed}, off`, can: false, installed: true };
  if (view.localConsent?.length) return { text: `Install on the device: everywhere plugin install ${view.manifest.id}`, can: false };
  return { text: "Not installed", can: true };
}

function PluginCard({
  listing,
  devices,
  busy,
  onInstall,
}: {
  listing: Listing;
  devices: Device[];
  busy: Record<string, string>;
  onInstall: (targets: Target[], update: boolean) => void;
}) {
  const { entries } = useFleet();
  const { plugin } = listing;
  const m = plugin.manifest;
  const rows = devices.map((device) => {
    const entry = entries.get(device.id);
    return { device, entry, s: standing(listing.devices.get(device.id), entry), busy: busy[`${m.id}\0${device.id}`] };
  });
  const installable = rows.filter((r) => r.s.can && !r.s.update && !r.busy).map((r) => ({ device: r.device, entry: r.entry! }));
  const updatable = rows.filter((r) => r.s.update && !r.busy).map((r) => ({ device: r.device, entry: r.entry! }));
  const enable = async (entry: DeviceContextValue) => {
    try {
      await entry.peer.callPlugin("plugins.enable", { id: m.id });
    } catch (e) {
      alert(errorMessage(e));
    }
  };
  return (
    <article className="rounded-lg border bg-card">
      <div className="flex gap-3 p-4">
        {plugin.icon ? <PluginLogo src={plugin.icon} className="mt-0.5 size-6" /> : <PuzzleIcon className="mt-0.5 size-6 text-muted-foreground" />}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 className="font-medium">{m.title}</h2>
            <span className="font-mono text-xs text-muted-foreground">{m.id}</span>
            <span className="text-xs text-muted-foreground">{m.version}</span>
            {plugin.homepage && (
              <a href={plugin.homepage} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-foreground">
                Source <ExternalLinkIcon className="inline size-3" />
              </a>
            )}
          </div>
          {m.description && <p className="text-sm">{m.description}</p>}
          <Asks manifest={m} />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {updatable.length > 0 && (
            <Button size="sm" onClick={() => onInstall(updatable, true)}>
              <RefreshCwIcon />
              Update{updatable.length > 1 ? ` (${updatable.length})` : ""}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant={updatable.length ? "outline" : "default"} disabled={installable.length === 0}>
                <DownloadIcon />
                Install
                <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Install {m.title} on</DropdownMenuLabel>
              {installable.length > 1 && (
                <>
                  <DropdownMenuItem onSelect={() => onInstall(installable, false)}>Every device that can ({installable.length})</DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {installable.map((t) => (
                <DropdownMenuItem key={t.device.id} onSelect={() => onInstall([t], false)}>
                  {deviceName(t.device, t.entry)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <ul className="grid gap-1 border-t px-4 py-2.5 text-xs">
        {rows.map((r) => (
          <li key={r.device.id} className="flex items-center gap-2">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                r.s.installed ? "bg-live" : r.s.update ? "bg-warn" : "bg-muted-foreground/40",
              )}
            />
            <span className="w-36 shrink-0 truncate">{deviceName(r.device, r.entry)}</span>
            <span className={cn("min-w-0 flex-1 truncate text-muted-foreground", r.busy && !r.busy.endsWith("…") && "text-destructive")}>
              {r.busy ?? r.s.text}
            </span>
            {r.s.installed && listing.devices.get(r.device.id)?.enabled === false && r.entry && (
              <Button size="sm" variant="ghost" className="h-5 px-1.5" onClick={() => enable(r.entry!)}>
                Turn on
              </Button>
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}

/** What a plugin asks for: its permissions and Claude tools. */
function Asks({ manifest: m }: { manifest: PluginManifest }) {
  const tools = m.contributes.tools ?? [];
  const quiet = tools.filter((t) => !t.ask);
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      {!!m.permissions?.length && <p>Can {m.permissions.map((x) => PERMISSIONS[x] ?? x).join(", ")}.</p>}
      {tools.length > 0 && (
        <p>
          {tools.length} tool{tools.length === 1 ? "" : "s"} for Claude
          {quiet.length > 0 && quiet.length < tools.length ? ` (${quiet.length} without asking)` : quiet.length ? ", without asking" : ", each asking first"}.
        </p>
      )}
    </div>
  );
}

function ConfirmInstall({
  state,
  onClose,
  onConfirm,
}: {
  state?: { plugin: CatalogPlugin; targets: Target[]; update: boolean };
  onClose: () => void;
  onConfirm: () => void;
}) {
  const m = state?.plugin.manifest;
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {state && m && (
          <>
            <DialogHeader>
              <DialogTitle>
                {state.update ? "Update" : "Install"} {m.title} {m.version}?
              </DialogTitle>
              <DialogDescription>
                On {state.targets.map((t) => deviceName(t.device, t.entry)).join(", ")}. It runs as you on{" "}
                {state.targets.length === 1 ? "that machine" : "those machines"} and can do anything you can.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 text-sm">
              {m.permissions?.length ? (
                <ul className="list-disc pl-5">
                  {m.permissions.map((p) => (
                    <li key={p}>{PERMISSIONS[p] ?? p}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">It asks for nothing beyond its own methods.</p>
              )}
              {!!m.contributes.tools?.length && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Tools for Claude</p>
                  <ul className="text-xs">
                    {m.contributes.tools.map((t) => (
                      <li key={t.name}>
                        <span className="font-mono">{m.id.replaceAll("-", "_")}_{t.name}</span>{" "}
                        <span className="text-muted-foreground">{t.ask ? "asks first" : "without asking"}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={onConfirm}>{state.update ? "Update" : "Install"}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- what each device has ------------------------------------------------------------

function Installed() {
  const { devices, entries } = useFleet();
  return (
    <div className="grid gap-4">
      {devices?.map((d) => {
        const entry = entries.get(d.id);
        const info = entry?.info.data;
        return (
          <Section key={d.id} title={deviceName(d, entry)} description={info ? `${info.os}/${info.arch} · ${info.version}` : "Offline"}>
            {!info || !entry ? (
              <p className="text-xs text-muted-foreground">Connect to the device to see its plugins.</p>
            ) : !info.plugins ? (
              <p className="text-xs text-muted-foreground">This device's daemon is from before plugins; update it to see them.</p>
            ) : (
              <div className="grid gap-3">
                <ul className="grid gap-3">
                  {info.plugins
                    .filter((p) => !p.builtin)
                    .map((p) => (
                      <PluginRow key={p.id} plugin={p} entry={entry} />
                    ))}
                  <StoppedPlugins entry={entry} running={info.plugins} />
                </ul>
                <details className="group">
                  <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
                    Built in ({info.plugins.filter((p) => p.builtin).length})
                  </summary>
                  <ul className="mt-3 grid gap-3">
                    {info.plugins
                      .filter((p) => p.builtin)
                      .map((p) => (
                        <PluginRow key={p.id} plugin={p} entry={entry} />
                      ))}
                  </ul>
                </details>
              </div>
            )}
          </Section>
        );
      })}
    </div>
  );
}

/** Installed plugins that aren't running: off, or failing to start. */
function StoppedPlugins({ entry, running }: { entry: DeviceContextValue; running: PluginInfo[] }) {
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  useEffect(() => {
    const load = () =>
      (entry.peer.callPlugin("plugins.installed", {}) as Promise<InstalledPlugin[]>).then(setInstalled, () => setInstalled([]));
    void load();
    return entry.peer.onEvent((ev) => {
      if ((ev as { event?: string }).event === "plugins.changed") void load();
    });
  }, [entry.peer]);
  const stopped = installed.filter((p) => !running.some((r) => r.id === p.id));
  return (
    <>
      {stopped.map((p) => (
        <li key={p.id} className="flex gap-3 text-sm">
          <PuzzleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-muted-foreground">{p.title}</span>
              <span className="font-mono text-xs text-muted-foreground">{p.id}</span>
              {p.version && <span className="text-xs text-muted-foreground">{p.version}</span>}
              <span className="rounded-sm bg-muted px-1 text-[10px] text-muted-foreground">{p.error ? "not running" : "off"}</span>
            </div>
            {p.error && <p className="text-xs text-destructive">{p.error}</p>}
            <PluginActions entry={entry} id={p.id} off={!p.enabled} />
          </div>
        </li>
      ))}
    </>
  );
}

/** Turn on, off and remove an installed plugin. */
function PluginActions({ entry, id, off, children }: { entry: DeviceContextValue; id: string; off?: boolean; children?: ReactNode }) {
  const [error, setError] = useState<string>();
  const run = (method: string) => entry.peer.callPlugin(method, { id }).then(() => setError(undefined), (e: unknown) => setError(errorMessage(e)));
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {children}
      {off ? (
        <Button variant="outline" size="sm" className="h-6" onClick={() => run("plugins.enable")}>
          Turn on
        </Button>
      ) : (
        <Button variant="outline" size="sm" className="h-6" onClick={() => run("plugins.disable")}>
          Turn off
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-6"
        onClick={() => confirm(`Remove ${id} from this device? Its settings and data stay, for a reinstall.`) && run("plugins.remove")}
      >
        <Trash2Icon />
        Remove
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
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
  const settingsButtons = (
    <>
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
    </>
  );
  return (
    <li className="flex gap-3 text-sm">
      {p.icon ? <PluginLogo src={p.icon} className="mt-0.5" /> : <PuzzleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
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
        {p.builtin ? (
          (hasSettings || p.settingsPage) && <div className="mt-1 flex flex-wrap gap-2">{settingsButtons}</div>
        ) : (
          <PluginActions entry={entry} id={p.id}>
            {settingsButtons}
          </PluginActions>
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
