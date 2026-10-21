// The remote desktop plugin: desktop tabs, opened on what claude opened
// when it uses the desktop tools.

import type { DesktopSource } from "@everywhere/protocol";
import { Link, useNavigate } from "@tanstack/react-router";
import { MonitorIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useRpc } from "@/lib/peer";
import { definePlugin, type DeviceProps, type PaneContext } from "../types";

const DesktopView = lazy(() => import("@/components/desktop/desktop-view").then((m) => ({ default: m.DesktopView })));

const DESKTOP_TOOL = /^mcp__everywhere__desktop_/;

/** Which desktop claude works on: its own (the default) or the user's. */
type Desk = "claude" | "yours";

/** The desktop a desktop tool call moved claude to, if it did. */
function deskOf(name: string, input: unknown): Desk | undefined {
  if (name === "mcp__everywhere__desktop_launch") return "claude";
  if (name !== "mcp__everywhere__desktop_open") return undefined;
  const d = (input as { desktop?: unknown } | undefined)?.desktop;
  return d === "claude" || d === "yours" ? d : undefined;
}

/**
 * What a desktop_open or desktop_launch call pointed claude at, on desk (the
 * desktop claude is on after it); undefined for other desktop tools.
 */
function openedSource(name: string, input: unknown, desk: Desk): DesktopSource | undefined {
  if (name === "mcp__everywhere__desktop_launch") return { desktop: "claude" };
  if (name !== "mcp__everywhere__desktop_open") return undefined;
  const i = (input ?? {}) as { window?: unknown; output?: unknown };
  const on: DesktopSource = desk === "yours" ? {} : { desktop: "claude" };
  if (typeof i.window === "string" && i.window) return { ...on, window: i.window };
  if (typeof i.output === "string" && i.output) return { ...on, output: i.output };
  return on;
}

// The desktop each claude pane's agent is on, as its calls left it.
const desks = new Map<string, Desk>();
// Desktop tabs being made, so a burst of calls makes one.
const creating = new Set<string>();

function DesktopPane({ ctx }: { ctx: PaneContext }) {
  const [show, setShow] = useState<{ source: DesktopSource; at: number } | undefined>();
  const id = ctx.pane.id;
  const { on } = ctx;
  useEffect(
    () => on("desktop.show", (e) => e.tabId === id && setShow({ source: e.source as DesktopSource, at: Date.now() })),
    [on, id],
  );
  return (
    <Suspense>
      <DesktopView
        peer={ctx.peer}
        deviceId={ctx.deviceId}
        deviceName={ctx.deviceName}
        active={ctx.shown}
        show={show}
        onAnnotate={ctx.sendToClaude}
        tab={{ id, state: ctx.pane.tabState, onStateChange: ctx.setTabState }}
      />
    </Suspense>
  );
}

/** In a device's menu in the sidebar: its whole desktop. */
function DesktopMenuItem({ entry }: DeviceProps) {
  const navigate = useNavigate();
  return (
    <DropdownMenuItem onSelect={() => void navigate({ to: "/d/$deviceId/desktop", params: { deviceId: entry.deviceId } })}>
      <MonitorIcon />
      Remote desktop
    </DropdownMenuItem>
  );
}

/** On a device's page, once remote desktop is on there and works. */
function DesktopHeaderButton({ entry }: DeviceProps) {
  const desktop = useRpc(entry.peer, "desktop.info", {});
  if (!desktop.data?.enabled || !desktop.data.available) return null;
  return (
    <Button variant="ghost" size="sm" className="ml-auto" asChild>
      <Link to="/d/$deviceId/desktop" params={{ deviceId: entry.deviceId }}>
        <MonitorIcon />
        Remote desktop
      </Link>
    </Button>
  );
}

export const desktop = definePlugin({
  id: "desktop",
  title: "Remote desktop",
  requires: { plugins: ["desktop"], features: ["desktop"] },
  device: { menu: [DesktopMenuItem], header: [DesktopHeaderButton] },
  tabs: [
    {
      kind: "desktop",
      title: "Desktop",
      icon: MonitorIcon,
      capture: "all",
      render: (ctx) => <DesktopPane ctx={ctx} />,
    },
  ],
  on: {
    "agent.toolUses": ({ paneId, uses }, ctx) => {
      const key = `${ctx.deviceId}/${paneId}`;
      let desk = desks.get(key) ?? "claude";
      let opened: DesktopSource | undefined;
      let used = false;
      for (const u of uses) {
        if (!DESKTOP_TOOL.test(u.name)) continue;
        desk = deskOf(u.name, u.input) ?? desk;
        if (!u.recent) continue;
        used = true;
        opened = openedSource(u.name, u.input, desk) ?? opened;
      }
      desks.set(key, desk);
      // Show the desktop as a tab, but not right after the user closed it.
      if (!used || !ctx.canTab || ctx.closedRecently("desktop", 120_000)) return;
      const existing = ctx.tabs.find((t) => t.kind === "desktop");
      if (existing) {
        if (opened) {
          ctx.emit("desktop.show", { tabId: existing.id, source: opened });
          void ctx.peer.call("tabs.setState", { id: existing.id, state: JSON.stringify({ source: opened }) }).catch(() => {});
        }
        return;
      }
      // A new tab shows the desktop claude is on.
      const source = opened ?? (desk === "claude" ? { desktop: "claude" } : {});
      if (creating.has(ctx.threadId)) return;
      creating.add(ctx.threadId);
      void ctx
        .openTab("desktop", { focus: false, state: JSON.stringify({ source }) })
        .finally(() => creating.delete(ctx.threadId));
    },
  },
});
