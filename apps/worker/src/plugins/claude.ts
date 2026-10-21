// The account's Claude token: one made with `claude setup-token`, which every
// device's daemon gives claude (CLAUDE_CODE_OAUTH_TOKEN) instead of signing
// in and renewing on its own. The hub keeps it sealed and sends it to
// daemons; the web app only ever sees its last few characters.

import { Hono } from "hono";
import { requireUser } from "../routes/auth";
import { open, seal } from "../secretbox";
import type { App } from "../types";
import { callHub, type HubHost, type WorkerPlugin } from "./types";

const TOKEN_KEY = "claudeToken";
interface StoredToken {
  sealed: string;
  /** Its last four characters, to tell tokens apart in Settings. */
  hint: string;
  setAt: number;
}

export type ClaudeTokenInfo = { set: false } | { set: true; hint: string; setAt: number };

async function tokenInfo(hub: HubHost): Promise<ClaudeTokenInfo> {
  const t = await hub.storage.get<StoredToken>(TOKEN_KEY);
  return t ? { set: true, hint: t.hint, setAt: t.setAt } : { set: false };
}

/**
 * Keeps the token (sealed), or with "" forgets it, and sends that to every
 * connected daemon that takes it; the rest get it when they next connect.
 * Reports what each device said.
 */
async function setToken(hub: HubHost, token: string): Promise<Record<string, string>> {
  if (token) {
    await hub.storage.put<StoredToken>(TOKEN_KEY, { sealed: await seal(hub.env, token), hint: token.slice(-4), setAt: Date.now() });
  } else {
    await hub.storage.delete(TOKEN_KEY);
  }
  const out: Record<string, string> = {};
  await Promise.all(
    hub.devicesWith("claudeToken").map(async (id) => {
      const r = await hub.deviceRpc(id, "agent.setToken", { token }, 15_000);
      out[id] = r.ok ? "ok" : r.message;
    }),
  );
  return out;
}

const routes = new Hono<App>();
routes.use("*", requireUser);

/** A setup-token token, or a key: what claude accepts there. */
const TOKEN = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

routes.get("/token", async (c) => c.json(await callHub<ClaudeTokenInfo>(c.env, c.var.user.id, "claude", "tokenInfo")));

/** Sets the token and sends it to every connected device; reports what each said. */
routes.put("/token", async (c) => {
  const body = await c.req.json<{ token?: unknown }>().catch(() => ({}) as { token?: unknown });
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!TOKEN.test(token)) {
    return c.json({ error: "that isn't a Claude token; `claude setup-token` prints one starting sk-ant-oat01-" }, 400);
  }
  const devices = await callHub<Record<string, string>>(c.env, c.var.user.id, "claude", "setToken", token);
  return c.json({ ...(await callHub<ClaudeTokenInfo>(c.env, c.var.user.id, "claude", "tokenInfo")), devices });
});

/** Forgets the token; devices go back to their own sign-in. */
routes.delete("/token", async (c) => {
  const devices = await callHub<Record<string, string>>(c.env, c.var.user.id, "claude", "setToken", "");
  return c.json({ ...(await callHub<ClaudeTokenInfo>(c.env, c.var.user.id, "claude", "tokenInfo")), devices });
});

export const claude: WorkerPlugin = {
  id: "claude",
  routes: [{ path: "/api/claude", app: routes }],
  legacyStorageKeys: [TOKEN_KEY],
  hubFeatures: ["claudeToken"],
  // A daemon that takes the account's Claude token gets it as it connects.
  onDaemonHello: async (hub, deviceId) => {
    const t = await hub.storage.get<StoredToken>(TOKEN_KEY);
    const token = t ? await open(hub.env, t.sealed) : "";
    const r = await hub.deviceRpc(deviceId, "agent.setToken", { token }, 15_000);
    if (!r.ok) console.warn(`sending ${deviceId} the Claude token: ${r.message}`);
  },
  hubMethods: {
    tokenInfo: (hub) => tokenInfo(hub),
    setToken: (hub, token) => setToken(hub, typeof token === "string" ? token : ""),
  },
};
