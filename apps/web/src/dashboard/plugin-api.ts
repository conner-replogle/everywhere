import type * as Everywhere from "everywhere";
import { useEffect, useRef, useState } from "react";
import { request, store } from "./frame";

/*
 * A plugin's web part's way out of the frame: everything goes through the
 * app, which only lets it reach its own plugin's methods and channels.
 */

function wrapPort(port: MessagePort): Everywhere.PluginChannel {
  const listeners = new Set<(data: string | ArrayBuffer) => void>();
  port.onmessage = (e: MessageEvent<{ t: "data"; data: string | ArrayBuffer } | { t: "close" }>) => {
    if (e.data.t === "data") for (const fn of listeners) fn(e.data.data);
  };
  port.start();
  return {
    send: (data) => port.postMessage({ t: "data", data }),
    onMessage: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close: () => {
      port.postMessage({ t: "close" });
      port.close();
    },
  };
}

export function usePlugin(): Everywhere.Plugin {
  const info = store.plugin;
  if (!info) throw new Error("usePlugin() is for plugins' web parts; this is a dashboard");
  const kv: Everywhere.PluginKV = {
    get: async <T,>(scope: string, key: string) => {
      const r = (await request({ method: "plugin.kv", params: { method: "get", scope, key } })) as { found: boolean; value?: T };
      return r.found ? (r.value as T) : undefined;
    },
    set: (scope, key, value) => request({ method: "plugin.kv", params: { method: "set", scope, key, value } }).then(() => {}),
    delete: (scope, key) => request({ method: "plugin.kv", params: { method: "delete", scope, key } }).then(() => {}),
    list: (scope, prefix = "") =>
      request({ method: "plugin.kv", params: { method: "list", scope, prefix } }) as Promise<{ key: string; value: unknown }[]>,
    scopes: (prefix = "") => request({ method: "plugin.kv", params: { method: "scopes", prefix } }) as Promise<string[]>,
  };
  return {
    id: info.id,
    view: info.view,
    kv,
    settings: {
      get: () => request({ method: "plugin.settings", params: {} }) as Promise<Record<string, Everywhere.PluginSettingValue>>,
      set: (values) =>
        request({ method: "plugin.setSettings", params: { values } }) as Promise<Record<string, Everywhere.PluginSettingValue>>,
    },
    pane: info.pane,
    threadId: info.threadId,
    tabState: info.tabState,
    call: <T,>(method: string, params?: unknown) =>
      request({ method: "plugin.call", params: { method, params } }) as Promise<T>,
    setTabState: (state) => {
      info.tabState = state;
      void request({ method: "plugin.setTabState", params: { state } });
    },
    openUrl: (url) => void request({ method: "plugin.openUrl", params: { url } }),
    channel: async (name, options) => {
      const port = (await request({ method: "plugin.channel", params: { name, ordered: options?.ordered } })) as MessagePort;
      return wrapPort(port);
    },
    useEvent: (fn) => {
      const ref = useRef(fn);
      ref.current = fn;
      useEffect(() => store.onPluginEvent((e) => ref.current(e as { event: string } & Record<string, unknown>)), []);
    },
  };
}

/** A key of the plugin's state, kept current: [value, set]. undefined while loading or unset. */
export function useKV<T>(scope: string, key: string): [T | undefined, (value: T | undefined) => Promise<void>] {
  const plugin = usePlugin();
  const [value, setValue] = useState<T | undefined>(undefined);
  const id = plugin.id;
  useEffect(() => {
    let live = true;
    const load = () => void plugin.kv.get<T>(scope, key).then((v) => live && setValue(v));
    load();
    const off = store.onPluginEvent((e) => {
      const ev = e as { event?: string; scope?: string; key?: string };
      if (ev.event === `${id}.kv.changed` && ev.scope === scope && ev.key === key) load();
    });
    return () => {
      live = false;
      off();
    };
    // plugin is new each render; what it reads is id, scope and key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, scope, key]);
  const set = async (v: T | undefined) => {
    setValue(v);
    if (v === undefined) await plugin.kv.delete(scope, key);
    else await plugin.kv.set(scope, key, v);
  };
  return [value, set];
}
