// The account's API keys for coding agents other than Claude, by the kind of
// their threads: Antigravity's, a Gemini API key. Every device's daemon gives
// an agent its key in place of the agent's own sign-in, so it needn't be
// signed in on each device. The hub keeps them sealed and sends them to
// daemons (every key at once, so one removed while a device was away is
// removed there too); the web app only ever sees their last few characters.

import { Hono } from "hono";
import { requireUser } from "../routes/auth";
import { open, seal } from "../secretbox";
import type { App } from "../types";
import { callHub, type HubHost, type WorkerPlugin } from "./types";

/** The agents that take a key, and what one looks like. */
export const KEYED_AGENTS: Record<string, { title: string; pattern: RegExp; wrong: string }> = {
  antigravity: {
    title: "Antigravity",
    pattern: /^AIza[0-9A-Za-z_-]{30,}$/,
    wrong: "that isn't a Gemini API key; aistudio.google.com/apikey makes one starting AIza",
  },
};

const KEYS_KEY = "keys";
interface StoredKey {
  sealed: string;
  /** Its last four characters, to tell keys apart in Settings. */
  hint: string;
  setAt: number;
}
type StoredKeys = Record<string, StoredKey>;

export type AgentKeyInfo = { set: false } | { set: true; hint: string; setAt: number };

async function keysInfo(hub: HubHost): Promise<Record<string, AgentKeyInfo>> {
  const stored = (await hub.storage.get<StoredKeys>(KEYS_KEY)) ?? {};
  const out: Record<string, AgentKeyInfo> = {};
  for (const kind of Object.keys(KEYED_AGENTS)) {
    const k = stored[kind];
    out[kind] = k ? { set: true, hint: k.hint, setAt: k.setAt } : { set: false };
  }
  return out;
}

/** Every key, opened: what a daemon is sent. */
async function openKeys(hub: HubHost): Promise<Record<string, string>> {
  const stored = (await hub.storage.get<StoredKeys>(KEYS_KEY)) ?? {};
  const out: Record<string, string> = {};
  for (const [kind, k] of Object.entries(stored)) out[kind] = await open(hub.env, k.sealed);
  return out;
}

/**
 * Keeps a kind's key (sealed), or with "" forgets it, and sends every key to
 * each connected daemon that takes them; the rest get them when they next
 * connect. Reports what each device said.
 */
async function setKey(hub: HubHost, kind: string, key: string): Promise<Record<string, string>> {
  const stored = (await hub.storage.get<StoredKeys>(KEYS_KEY)) ?? {};
  if (key) stored[kind] = { sealed: await seal(hub.env, key), hint: key.slice(-4), setAt: Date.now() };
  else delete stored[kind];
  if (Object.keys(stored).length) await hub.storage.put<StoredKeys>(KEYS_KEY, stored);
  else await hub.storage.delete(KEYS_KEY);
  const keys = await openKeys(hub);
  const out: Record<string, string> = {};
  await Promise.all(
    hub.devicesWith("agentKeys").map(async (id) => {
      const r = await hub.deviceRpc(id, "agent.setKeys", { keys }, 15_000);
      out[id] = r.ok ? "ok" : r.message;
    }),
  );
  return out;
}

const routes = new Hono<App>();
routes.use("*", requireUser);

routes.get("/", async (c) => c.json(await callHub<Record<string, AgentKeyInfo>>(c.env, c.var.user.id, "agentKeys", "info")));

/** Sets a kind's key and sends it to every connected device; reports what each said. */
routes.put("/:kind", async (c) => {
  const kind = c.req.param("kind");
  const agent = KEYED_AGENTS[kind];
  if (!agent) return c.json({ error: `no agent ${kind} takes an API key` }, 404);
  const body = await c.req.json<{ key?: unknown }>().catch(() => ({}) as { key?: unknown });
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!agent.pattern.test(key)) return c.json({ error: agent.wrong }, 400);
  const devices = await callHub<Record<string, string>>(c.env, c.var.user.id, "agentKeys", "setKey", { kind, key });
  const info = await callHub<Record<string, AgentKeyInfo>>(c.env, c.var.user.id, "agentKeys", "info");
  return c.json({ ...info[kind], devices });
});

/** Forgets a kind's key; devices go back to the agent's own sign-in. */
routes.delete("/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (!KEYED_AGENTS[kind]) return c.json({ error: `no agent ${kind} takes an API key` }, 404);
  const devices = await callHub<Record<string, string>>(c.env, c.var.user.id, "agentKeys", "setKey", { kind, key: "" });
  const info = await callHub<Record<string, AgentKeyInfo>>(c.env, c.var.user.id, "agentKeys", "info");
  return c.json({ ...info[kind], devices });
});

export const agentKeys: WorkerPlugin = {
  id: "agentKeys",
  routes: [{ path: "/api/agent-keys", app: routes }],
  hubFeatures: ["agentKeys"],
  // A daemon gets every key as it connects, so one removed meanwhile goes too.
  onDaemonHello: async (hub, deviceId) => {
    const keys = await openKeys(hub);
    const r = await hub.deviceRpc(deviceId, "agent.setKeys", { keys }, 15_000);
    if (!r.ok) console.warn(`sending ${deviceId} the agent keys: ${r.message}`);
  },
  hubMethods: {
    info: (hub) => keysInfo(hub),
    setKey: (hub, args) => {
      const { kind, key } = (args ?? {}) as { kind?: unknown; key?: unknown };
      if (typeof kind !== "string" || !KEYED_AGENTS[kind]) throw new Error("no such agent");
      return setKey(hub, kind, typeof key === "string" ? key : "");
    },
  },
};
