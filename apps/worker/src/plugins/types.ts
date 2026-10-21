// The Worker's plugin API. Worker plugins are built in (a Worker can't load
// code at runtime): each mounts its routes, handles the daemon messages it
// owns, says which hub features it serves, and can keep state in the
// account's hub. See PLUGINS.md.

import type { HubFeature, HubToClient, RemoteMethod, RemoteMethods } from "@everywhere/protocol";
import type { Hono } from "hono";
import type { DeviceRpcResult } from "../hub";
import type { App } from "../types";

/** What the account's hub (AccountHub) gives plugins. */
export interface HubHost {
  env: Env;
  /** The hub's storage, under keys only this plugin uses. */
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
    /** Its keys (not legacy ones) and their values. */
    list<T>(): Promise<Map<string, T>>;
  };
  deviceRpc<M extends RemoteMethod>(
    deviceId: string,
    method: M,
    params: RemoteMethods[M][0],
    timeoutMs?: number,
  ): Promise<DeviceRpcResult<RemoteMethods[M][1]>>;
  /** Connected daemons that announced a hub feature. */
  devicesWith(feature: HubFeature): string[];
  /** Sends a message to every browser tab. */
  broadcast(msg: HubToClient): void;
  /** Whether a browser tab is showing a thread (visible and focused). */
  viewing(deviceId: string, threadId: string): boolean;
  /** Whether someone is using the app in a tab right now. */
  inUse(): boolean;
  waitUntil(p: Promise<unknown>): void;
}

export interface WorkerPlugin {
  id: string;
  /** Hono apps mounted at their paths. */
  routes?: { path: string; app: Hono<App> }[];
  /** Keys it kept in the hub's storage before storage was per plugin; they keep their names. */
  legacyStorageKeys?: string[];
  /** Hub features (from a daemon's hello) this plugin serves. */
  hubFeatures?: HubFeature[];
  /** A daemon said hello, with these of this plugin's features. */
  onDaemonHello?: (hub: HubHost, deviceId: string, features: HubFeature[]) => Promise<void>;
  /** Daemon → hub messages by their t. */
  daemonMessages?: Record<string, (hub: HubHost, deviceId: string, msg: unknown) => Promise<void>>;
  /** Called from routes through AccountHub.plugin(id, method, args). */
  hubMethods?: Record<string, (hub: HubHost, args: unknown) => Promise<unknown>>;
}

/** Calls a plugin's hub method in the account's hub. */
export async function callHub<T>(env: Env, accountId: string, plugin: string, method: string, args?: unknown): Promise<T> {
  return (await env.HUB.get(env.HUB.idFromName(accountId)).plugin(plugin, method, args ?? null)) as T;
}
