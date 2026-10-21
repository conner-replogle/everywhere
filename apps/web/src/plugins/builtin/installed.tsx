// Installed plugins in the app's own places: each one's sidebar section,
// badges on thread rows, and items in its device's menu, drawn from what
// its methods answer (see plugins/data). Their tabs and thread header
// buttons come with each device's plugin list (plugins/external).

import type { PluginBadge, PluginSidebar, PluginSidebarRow, Thread } from "@everywhere/protocol";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { type DeviceContextValue } from "@/components/device-context";
import { useFleet } from "@/components/fleet";
import { deviceName } from "@/components/scratch";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { PluginBoundary } from "../boundary";
import { installedPlugins, pluginIcon, runAction, usePluginData } from "../data";
import { definePlugin, type DeviceProps, type SidebarSectionProps } from "../types";

const TONES: Record<string, string> = {
  live: "bg-live/15 text-live",
  warn: "bg-warn/15 text-warn",
  muted: "bg-muted text-muted-foreground",
};

export function Badge({ badge }: { badge: PluginBadge }) {
  return (
    <span className={cn("shrink-0 rounded-sm px-1 text-[10px] tabular-nums", TONES[badge.tone ?? "muted"] ?? TONES.muted)}>
      {badge.text}
    </span>
  );
}

/** One plugin's section, on one device. */
function Section({
  entry,
  plugin,
  method,
  title: fallbackTitle,
  props,
}: {
  entry: DeviceContextValue;
  plugin: string;
  method: string;
  title: string;
  props: SidebarSectionProps;
}) {
  const { data } = usePluginData<PluginSidebar>(entry, plugin, method);
  const key = `plugin:${plugin}:${entry.deviceId}`;
  // A plugin's answer is data from outside the app: only well-formed rows are drawn.
  const rows = (Array.isArray(data?.rows) ? data.rows : []).filter(
    (r): r is PluginSidebarRow => !!r && typeof r === "object" && typeof r.label === "string",
  );
  if (!data || rows.length === 0) return null;
  const title = typeof data.title === "string" && data.title ? data.title : fallbackTitle;
  const collapsed = props.collapsed.has(key);
  const many = props.entries.filter((e) => installedPlugins(e).some((p) => p.id === plugin)).length > 1;
  return (
    <div className="max-h-[30%] shrink-0 overflow-y-auto border-b px-1.5 pt-1 pb-1.5">
      <button
        type="button"
        onClick={() => props.toggle(key)}
        className="flex h-7 w-full items-center gap-1.5 rounded-md pl-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none pointer-coarse:h-9"
        aria-expanded={!collapsed}
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", !collapsed && "rotate-90")} />
        <span className="truncate">{title}</span>
        {many && <span className="truncate font-normal">· {deviceName(entry)}</span>}
        {collapsed && <span className="tabular-nums">{rows.length}</span>}
      </button>
      {!collapsed && (
        <ul className="flex flex-col gap-px">
          {rows.slice(0, 50).map((row, i) => {
            const Icon = pluginIcon(row.icon);
            const body = (
              <>
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{row.label}</span>
                  {row.detail && <span className="truncate text-[11px] text-muted-foreground">{row.detail}</span>}
                </span>
                {row.badge && typeof row.badge.text === "string" && (
                  <span className="ml-auto pl-1">
                    <Badge badge={row.badge} />
                  </span>
                )}
              </>
            );
            const cls =
              "flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-0.5 text-left hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none pointer-coarse:min-h-10";
            return (
              <li key={i}>
                {typeof row.threadId === "string" && row.threadId ? (
                  <Link to="/d/$deviceId/t/$threadId" params={{ deviceId: entry.deviceId, threadId: row.threadId }} className={cls}>
                    {body}
                  </Link>
                ) : row.action ? (
                  <button
                    type="button"
                    className={cls}
                    onClick={() => runAction(plugin, row.action!, { peer: entry.peer, onError: (m) => props.onError(m) })}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={cls}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Sections(props: SidebarSectionProps) {
  return (
    <>
      {props.entries.flatMap((entry) =>
        installedPlugins(entry)
          .filter((p) => p.ui?.sidebar)
          .map((p) => (
            <PluginBoundary key={`${entry.deviceId}:${p.id}`} plugin={p.id}>
              <Section entry={entry} plugin={p.id} method={p.ui!.sidebar!.method} title={p.title} props={props} />
            </PluginBoundary>
          )),
      )}
    </>
  );
}

/** One plugin's badges for a device's threads. */
function PluginBadge({ entry, plugin, method, threadId }: { entry: DeviceContextValue; plugin: string; method: string; threadId: string }) {
  const { data } = usePluginData<Record<string, PluginBadge>>(entry, plugin, method);
  const b = data && typeof data === "object" ? data[threadId] : undefined;
  return b && typeof b.text === "string" ? <Badge badge={b} /> : null;
}

function ThreadBadges({ thread, deviceId }: { thread: Thread; deviceId?: string }) {
  const entry = useFleet().entries.get(deviceId ?? "");
  if (!entry) return null;
  return (
    <>
      {installedPlugins(entry)
        .filter((p) => p.ui?.threadBadges)
        .map((p) => (
          <PluginBoundary key={p.id} plugin={p.id}>
            <PluginBadge entry={entry} plugin={p.id} method={p.ui!.threadBadges!.method} threadId={thread.id} />
          </PluginBoundary>
        ))}
    </>
  );
}

function DeviceMenu({ entry }: DeviceProps) {
  return (
    <>
      {installedPlugins(entry).flatMap((p) =>
        (p.ui?.deviceMenu ?? []).map((a, i) => {
          const Icon = pluginIcon(a.icon);
          return (
            <DropdownMenuItem key={`${p.id}:${i}`} onSelect={() => runAction(p.id, a, { peer: entry.peer })}>
              <Icon />
              {a.label}
            </DropdownMenuItem>
          );
        }),
      )}
    </>
  );
}

export const installed = definePlugin({
  id: "installed-plugins",
  title: "Installed plugins",
  sidebar: { sections: [{ order: 50, component: Sections }], threadBadges: [ThreadBadges] },
  device: { menu: [DeviceMenu] },
});
