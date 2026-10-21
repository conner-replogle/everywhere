// What installed plugins show in the app's own places (sidebar sections,
// thread badges, header buttons, device menu items): data from their
// methods, drawn by the app, so no plugin code runs here. See PluginUI.

import type { PluginAction, PluginInfo } from "@everywhere/protocol";
import {
  BellIcon,
  BookmarkIcon,
  CheckIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FlagIcon,
  InfoIcon,
  LinkIcon,
  ListIcon,
  NotebookPenIcon,
  PlayIcon,
  PuzzleIcon,
  RefreshCwIcon,
  StarIcon,
  TagIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import type { DeviceContextValue } from "@/components/device-context";
import type { DevicePeer } from "@/lib/peer";
import { errorMessage } from "@/lib/utils";

/** Icons a plugin can name; anything else is a puzzle piece. */
const ICONS: Record<string, LucideIcon> = {
  bell: BellIcon,
  bookmark: BookmarkIcon,
  check: CheckIcon,
  external: ExternalLinkIcon,
  file: FileTextIcon,
  flag: FlagIcon,
  info: InfoIcon,
  link: LinkIcon,
  list: ListIcon,
  notes: NotebookPenIcon,
  play: PlayIcon,
  refresh: RefreshCwIcon,
  star: StarIcon,
  tag: TagIcon,
  trash: Trash2Icon,
};

export function pluginIcon(name: string | undefined): LucideIcon {
  return (name && ICONS[name]) || PuzzleIcon;
}

/** Installed plugins a device runs (built-ins' web parts draw themselves). */
export function installedPlugins(entry: DeviceContextValue | undefined): PluginInfo[] {
  return (entry?.info.data?.plugins ?? []).filter((p) => !p.builtin);
}

// --- a shared, refetching query per device, method and params ------------------

interface Query {
  data?: unknown;
  error?: string;
  listeners: Set<() => void>;
  stop?: () => void;
  loading?: boolean;
  /** For useSyncExternalStore: a new object when it changes. */
  snapshot: { data?: unknown; error?: string };
}

const queries = new Map<string, Query>();

function fetchQuery(q: Query, peer: DevicePeer, method: string, params: unknown) {
  if (q.loading) return;
  q.loading = true;
  peer
    .callPlugin(method, params)
    .then(
      (data) => {
        q.data = data;
        q.error = undefined;
      },
      (e: unknown) => {
        q.error = errorMessage(e);
      },
    )
    .finally(() => {
      q.loading = false;
      q.snapshot = { data: q.data, error: q.error };
      for (const l of q.listeners) l();
    });
}

/**
 * Calls a plugin's method for UI data, shared by every component asking
 * the same of the same device, and again when the plugin says its UI or
 * state changed, or threads did.
 */
export function usePluginData<T>(
  entry: DeviceContextValue | undefined,
  plugin: string,
  method: string | undefined,
  params: unknown = {},
): { data?: T; error?: string } {
  const connected = entry?.conn.state === "connected";
  const key = entry && method && connected ? `${entry.deviceId}\u0000${entry.conn.generation}\u0000${method}\u0000${JSON.stringify(params)}` : "";
  const q = key ? (queries.get(key) ?? newQuery(key)) : undefined;
  useEffect(() => {
    if (!q || !entry || !method) return;
    const listener = () => {};
    q.listeners.add(listener);
    if (q.data === undefined && !q.error) fetchQuery(q, entry.peer, method, params);
    if (!q.stop) {
      q.stop = entry.peer.onEvent((e) => {
        const name = (e as { event?: string }).event ?? "";
        if (name === "threads.changed" || name === `${plugin}.ui.changed` || name === `${plugin}.kv.changed`) {
          fetchQuery(q, entry.peer, method, params);
        }
      });
    }
    return () => {
      q.listeners.delete(listener);
      if (q.listeners.size === 0) {
        q.stop?.();
        queries.delete(key);
      }
    };
    // params are in the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const snap = useSyncExternalStore(
    (fn) => {
      if (!q) return () => {};
      q.listeners.add(fn);
      return () => q.listeners.delete(fn);
    },
    () => q?.snapshot ?? EMPTY,
  );
  return snap as { data?: T; error?: string };
}

const EMPTY = {};

function newQuery(key: string): Query {
  const q: Query = { listeners: new Set(), snapshot: {} };
  queries.set(key, q);
  return q;
}

/** What running an action needs: where it is (a thread's header adds threadId) and how to open a tab. */
export interface ActionContext {
  peer: DevicePeer;
  threadId?: string;
  openTab?: (kind: string) => void;
  onError?: (message: string) => void;
}

/** Runs a plugin's action: a call to one of its methods, a tab of one of its kinds, or a link. */
export function runAction(plugin: string, a: PluginAction, ctx: ActionContext) {
  if (a.href) {
    if (/^https?:\/\//i.test(a.href)) window.open(a.href, "_blank", "noopener,noreferrer");
    return;
  }
  if (a.openTab) {
    ctx.openTab?.(a.openTab);
    return;
  }
  if (a.call?.startsWith(`${plugin}.`)) {
    const params = { ...(a.params && typeof a.params === "object" ? a.params : {}), ...(ctx.threadId ? { threadId: ctx.threadId } : {}) };
    ctx.peer.callPlugin(a.call, params).catch((e: unknown) => ctx.onError?.(errorMessage(e)));
  }
}
