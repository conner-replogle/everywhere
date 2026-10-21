// External plugins: installed on a device, with a web part the device
// builds (plugins.web) and the app runs in the sandboxed frame dashboards
// use (/dashboard): an opaque origin with no network. Everything the frame
// does goes through here, and only to its own plugin: methods named
// "<id>.…", channels "<id>/…", its tab's state, links.

import type { DashboardBuild, PluginAction, PluginInfo } from "@everywhere/protocol";
import { OctagonAlertIcon, PuzzleIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DeviceContextValue } from "@/components/device-context";
import { type FrameTheme, type FromFrame, THEME_VARS, type ToFrame } from "@/dashboard/bridge";
import { Button } from "@/components/ui/button";
import type { DevicePeer } from "@/lib/peer";
import { errorMessage } from "@/lib/utils";
import { PluginBoundary } from "./boundary";
import { pluginIcon, runAction, usePluginData } from "./data";
import { pluginSettings, setPluginSettings } from "./settings";
import { definePlugin, type PaneContext, type ThreadContext, type WebPlugin } from "./types";

const START_MS = 10_000;

function currentTheme(): FrameTheme {
  const style = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const name of THEME_VARS) vars[name] = style.getPropertyValue(name).trim();
  return { vars, dark: style.colorScheme !== "light" };
}

/** A web plugin for each external plugin the device runs with a web part. */
export function useExternalPlugins(entry: DeviceContextValue): readonly WebPlugin[] {
  const plugins = entry.info.data?.plugins;
  // Keyed on what they declare, so a new device.info with the same plugins keeps them.
  const key = JSON.stringify((plugins ?? []).filter((p) => !p.builtin && p.web).map((p) => [p.id, p.contributes.kinds]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (plugins ?? []).filter((p) => !p.builtin && p.web).map(externalPlugin), [key]);
}

function externalPlugin(info: PluginInfo): WebPlugin {
  const header = info.ui?.threadHeader?.method;
  return definePlugin({
    id: info.id,
    title: info.title,
    requires: { plugins: [info.id] },
    tabs: (info.contributes.kinds ?? []).map((k) => ({
      kind: k.kind,
      title: k.title || info.title,
      icon: PuzzleIcon,
      single: k.single,
      capture: "all",
      render: (ctx: PaneContext) => (
        <PluginView
          plugin={info}
          host={{
            peer: ctx.peer,
            generation: ctx.generation,
            view: "tab",
            pane: { id: ctx.pane.id, kind: ctx.pane.kind, name: ctx.pane.name, tabState: ctx.pane.tabState },
            threadId: ctx.threadId,
            setTabState: ctx.setTabState,
            openUrl: ctx.openUrl,
          }}
        />
      ),
    })),
    threadHeader: header
      ? [
          ({ ctx }) => (
            <PluginBoundary plugin={info.id}>
              <HeaderActions ctx={ctx} plugin={info.id} method={header} />
            </PluginBoundary>
          ),
        ]
      : undefined,
  });
}

/** An installed plugin's buttons in a thread's header. */
function HeaderActions({ ctx, plugin, method }: { ctx: ThreadContext; plugin: string; method: string }) {
  const { data } = usePluginData<PluginAction[]>(ctx.entry, plugin, method, { threadId: ctx.threadId });
  const actions = (Array.isArray(data) ? data : []).filter(
    (a): a is PluginAction => !!a && typeof a === "object" && typeof a.label === "string",
  );
  if (ctx.archived || actions.length === 0) return null;
  return (
    <>
      {actions.slice(0, 3).map((a, i) => {
        const Icon = pluginIcon(a.icon);
        return (
          <Button
            key={i}
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={() =>
              runAction(plugin, a, {
                peer: ctx.peer,
                threadId: ctx.threadId,
                openTab: (kind) => void ctx.openTab(kind),
                onError: ctx.setError,
              })
            }
          >
            <Icon />
            {a.label}
          </Button>
        );
      })}
    </>
  );
}

/** Where a plugin's frame is shown, and what it may do there. */
export interface FrameHost {
  peer: DevicePeer;
  generation: number;
  /** A tab of one of its kinds, or its settings page. */
  view: "tab" | "settings";
  pane: { id: string; kind: string; name: string; tabState?: string };
  threadId?: string;
  setTabState?: (state: string) => void;
  openUrl?: (url: string) => void;
}

/** A plugin's web part, built on the device, in its sandboxed frame. */
export function PluginView({ host, plugin }: { host: FrameHost; plugin: PluginInfo }) {
  const { peer } = host;
  const [build, setBuild] = useState<DashboardBuild | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setBuild(null);
    peer
      .callPlugin("plugins.web", { id: plugin.id }, 60_000)
      .then((b) => live && setBuild(b as DashboardBuild))
      .catch((e: unknown) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [peer, plugin.id, host.generation]);

  if (error) return <Message title={`Couldn't load ${plugin.title}`}>{error}</Message>;
  if (!build) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        <PuzzleIcon className="mr-2 size-4 animate-pulse" />
        Loading {plugin.title}…
      </div>
    );
  }
  if (build.errors?.length || !build.js) {
    return (
      <Message title={`${plugin.title}'s web part doesn't build`}>
        <pre className="overflow-auto rounded-md border bg-card p-3 text-left font-mono text-[11px] whitespace-pre-wrap">
          {(build.errors ?? []).join("\n\n")}
        </pre>
      </Message>
    );
  }
  return <PluginFrame key={build.version} host={host} plugin={plugin} build={build} />;
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 overflow-auto p-6 text-center text-xs text-muted-foreground">
      <OctagonAlertIcon className="size-5 text-destructive" />
      <p className="font-medium text-foreground">{title}</p>
      <div className="grid max-w-2xl gap-2">{children}</div>
    </div>
  );
}

function PluginFrame({ host, plugin, build }: { host: FrameHost; plugin: PluginInfo; build: DashboardBuild }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [stuck, setStuck] = useState(false);
  const hostRef = useRef(host);
  hostRef.current = host;
  const { peer } = host;
  const id = plugin.id;

  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setStuck(true), START_MS);
    return () => clearTimeout(t);
  }, [ready]);

  const send = (msg: ToFrame, transfer?: Transferable[]) => {
    frame.current?.contentWindow?.postMessage(msg, "*", transfer ?? []);
  };

  useEffect(() => {
    const channels: RTCDataChannel[] = [];
    const onMessage = async (e: MessageEvent<FromFrame>) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const msg = e.data;
      const c = hostRef.current;
      if (msg.t === "ready") {
        const p = c.pane;
        send({
          t: "plugin-init",
          js: build.js!,
          css: build.css,
          theme: currentTheme(),
          plugin: { id, view: c.view, pane: { id: p.id, kind: p.kind, name: p.name }, threadId: c.threadId ?? "", tabState: p.tabState },
        });
        setReady(true);
        return;
      }
      if (msg.t !== "request") return;
      try {
        switch (msg.method) {
          case "plugin.call": {
            const method = String(msg.params.method);
            if (!method.startsWith(`${id}.`)) throw new Error(`a plugin can only call its own methods (${id}.…)`);
            send({ t: "reply", id: msg.id, result: await peer.callPlugin(method, msg.params.params ?? {}) });
            return;
          }
          case "plugin.setTabState":
            c.setTabState?.(String(msg.params.state));
            send({ t: "reply", id: msg.id, result: null });
            return;
          case "plugin.openUrl": {
            const url = String(msg.params.url);
            if (!/^https?:\/\//i.test(url)) throw new Error("only http(s) links open");
            if (c.openUrl) c.openUrl(url);
            else window.open(url, "_blank", "noopener,noreferrer");
            send({ t: "reply", id: msg.id, result: null });
            return;
          }
          case "plugin.kv": {
            const { method, ...params } = msg.params;
            if (!["get", "set", "delete", "list", "scopes"].includes(method)) throw new Error(`no kv method ${method}`);
            send({ t: "reply", id: msg.id, result: await peer.callPlugin(`plugins.kv.${method}`, { ...params, plugin: id }) });
            return;
          }
          case "plugin.settings":
            send({ t: "reply", id: msg.id, result: await pluginSettings(peer, plugin) });
            return;
          case "plugin.setSettings":
            await setPluginSettings(peer, plugin, msg.params.values);
            send({ t: "reply", id: msg.id, result: await pluginSettings(peer, plugin) });
            return;
          case "plugin.channel": {
            const dc = peer.openChannel(`${id}/${String(msg.params.name)}`, { ordered: msg.params.ordered ?? true });
            channels.push(dc);
            const { port1, port2 } = new MessageChannel();
            dc.onmessage = (ev) => port1.postMessage({ t: "data", data: ev.data });
            dc.onclose = () => port1.close();
            port1.onmessage = (ev: MessageEvent<{ t: "data"; data: string | ArrayBuffer } | { t: "close" }>) => {
              if (ev.data.t === "close") dc.close();
              else if (dc.readyState === "open") dc.send(ev.data.data as string);
            };
            await new Promise<void>((resolve, reject) => {
              if (dc.readyState === "open") return resolve();
              dc.onopen = () => resolve();
              dc.onerror = () => reject(new Error("the channel didn't open"));
            });
            send({ t: "reply", id: msg.id, result: port2 }, [port2]);
            return;
          }
          default:
            throw new Error(`a plugin can't ask for ${msg.method}`);
        }
      } catch (err) {
        send({ t: "reply", id: msg.id, error: errorMessage(err) });
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const dc of channels) dc.close();
    };
    // build is fixed for this frame (a new one remounts it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peer, id]);

  // Its events from the device.
  useEffect(() => {
    if (!ready) return;
    return peer.onEvent((e) => {
      const name = (e as { event?: unknown }).event;
      if (typeof name === "string" && name.startsWith(`${id}.`)) send({ t: "plugin-event", event: e });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, peer, id]);

  // The theme, when the user changes it.
  useEffect(() => {
    if (!ready) return;
    const observer = new MutationObserver(() => send({ t: "theme", theme: currentTheme() }));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    return () => observer.disconnect();
  }, [ready]);

  if (stuck && !ready) {
    return (
      <Message title={`${plugin.title} didn't start`}>
        <span>Its frame's scripts didn't load. Reload the app.</span>
      </Message>
    );
  }
  return (
    <iframe
      ref={frame}
      src="/dashboard"
      title={plugin.title}
      // Scripts only: an opaque origin, so it can't reach the app's storage or the device.
      sandbox="allow-scripts"
      className="h-full w-full border-0 bg-background"
    />
  );
}
