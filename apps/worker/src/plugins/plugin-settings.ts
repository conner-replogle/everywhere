// Plugins' account settings: values that belong to the account rather than
// one device (an API key used everywhere). The app saves them here; the hub
// keeps them sealed and sends each plugin's to every daemon that takes them
// (hub feature pluginSettings), as it connects and when they change. The
// browser only ever sees whether a secret is set and how it ends.

import { Hono } from "hono";
import { requireUser } from "../routes/auth";
import { open, seal } from "../secretbox";
import type { App } from "../types";
import { callHub, type HubHost, type WorkerPlugin } from "./types";

interface Stored {
  /** The values, sealed (JSON). */
  sealed: string;
  /** Which keys are secrets, as the app said when saving them. */
  secrets: string[];
}

type View = Record<string, { value?: unknown; set: boolean; hint?: string }>;

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const KEY = /^[a-z][a-z0-9_]{0,47}$/;
const MAX_BYTES = 64 << 10;

async function values(hub: HubHost, id: string): Promise<{ values: Record<string, unknown>; secrets: string[] }> {
  const s = await hub.storage.get<Stored>(id);
  if (!s) return { values: {}, secrets: [] };
  return { values: JSON.parse(await open(hub.env, s.sealed)) as Record<string, unknown>, secrets: s.secrets };
}

function view({ values, secrets }: { values: Record<string, unknown>; secrets: string[] }): View {
  const out: View = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = secrets.includes(k) ? { set: true, hint: typeof v === "string" && v.length > 4 ? v.slice(-4) : undefined } : { set: true, value: v };
  }
  return out;
}

async function push(hub: HubHost, id: string, vals: Record<string, unknown>, devices = hub.devicesWith("pluginSettings")) {
  const out: Record<string, string> = {};
  await Promise.all(
    devices.map(async (d) => {
      const r = await hub.deviceRpc(d, "plugins.setAccountSettings", { id, values: vals }, 15_000);
      out[d] = r.ok ? "ok" : r.message;
    }),
  );
  return out;
}

const routes = new Hono<App>();
routes.use("*", requireUser);

routes.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID.test(id)) return c.json({ error: "bad plugin id" }, 400);
  return c.json(await callHub<View>(c.env, c.var.user.id, "plugin-settings", "get", id));
});

/** Merges values (null clears one) and sends them to the devices; secrets names the secret keys. */
routes.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ values?: unknown; secrets?: unknown }>().catch(() => ({}) as { values?: unknown; secrets?: unknown });
  if (!ID.test(id) || !body.values || typeof body.values !== "object" || Array.isArray(body.values)) {
    return c.json({ error: "give values for a plugin" }, 400);
  }
  const entries = Object.entries(body.values as Record<string, unknown>);
  if (entries.some(([k]) => !KEY.test(k))) return c.json({ error: "bad setting key" }, 400);
  const secrets = Array.isArray(body.secrets) ? body.secrets.filter((k): k is string => typeof k === "string" && KEY.test(k)) : [];
  if (JSON.stringify(body.values).length > MAX_BYTES) return c.json({ error: "too big" }, 400);
  return c.json(await callHub(c.env, c.var.user.id, "plugin-settings", "set", { id, values: body.values, secrets }));
});

export const pluginSettings: WorkerPlugin = {
  id: "plugin-settings",
  routes: [{ path: "/api/plugin-settings", app: routes }],
  hubFeatures: ["pluginSettings"],
  // A daemon that takes them gets every plugin's as it connects.
  onDaemonHello: async (hub, deviceId) => {
    for (const id of (await hub.storage.list<Stored>()).keys()) {
      const { values: vals } = await values(hub, id);
      await push(hub, id, vals, [deviceId]);
    }
  },
  hubMethods: {
    get: async (hub, id) => view(await values(hub, String(id))),
    set: async (hub, args) => {
      const { id, values: changes, secrets } = args as { id: string; values: Record<string, unknown>; secrets: string[] };
      const cur = await values(hub, id);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) delete cur.values[k];
        else cur.values[k] = v;
      }
      const allSecrets = [...new Set([...cur.secrets, ...secrets])].filter((k) => k in cur.values);
      if (Object.keys(cur.values).length === 0) await hub.storage.delete(id);
      else await hub.storage.put<Stored>(id, { sealed: await seal(hub.env, JSON.stringify(cur.values)), secrets: allSecrets });
      const devices = await push(hub, id, cur.values);
      return { values: view({ values: cur.values, secrets: allSecrets }), devices };
    },
  },
};
