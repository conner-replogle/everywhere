// The account's Claude token: one made with `claude setup-token`, which every
// device's daemon gives claude (CLAUDE_CODE_OAUTH_TOKEN) instead of signing
// in and renewing on its own. The hub keeps it sealed and sends it to
// daemons; the web app only ever sees its last few characters.
//
// And the account's custom instructions: text every device's daemon adds to
// each claude thread's system prompt. The hub keeps them and sends them to
// daemons the same way.

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
async function setToken(hub: HubHost, token: string): Promise<ClaudeTokenInfo & { devices: Record<string, string> }> {
  let info: ClaudeTokenInfo;
  if (token) {
    const stored: StoredToken = { sealed: await seal(hub.env, token), hint: token.slice(-4), setAt: Date.now() };
    await hub.storage.put<StoredToken>(TOKEN_KEY, stored);
    info = { set: true, hint: stored.hint, setAt: stored.setAt };
  } else {
    await hub.storage.delete(TOKEN_KEY);
    info = { set: false };
  }
  const devices: Record<string, string> = {};
  await Promise.all(
    hub.devicesWith("claudeToken").map(async (id) => {
      const r = await hub.deviceRpc(id, "agent.setToken", { token }, 15_000);
      devices[id] = r.ok ? "ok" : r.message;
    }),
  );
  return { ...info, devices };
}

const INSTRUCTIONS_KEY = "instructions";
/** About 4k tokens: room for real guidance without crowding every thread's context. */
export const MAX_INSTRUCTIONS = 16_000;
interface StoredInstructions {
  text: string;
  setAt: number;
}

export type ClaudeInstructions = { text: string; setAt?: number };

async function instructions(hub: HubHost): Promise<ClaudeInstructions> {
  const s = await hub.storage.get<StoredInstructions>(INSTRUCTIONS_KEY);
  return s ? { text: s.text, setAt: s.setAt } : { text: "" };
}

/** Keeps them ("" forgets them) and sends them to every connected daemon that takes them. */
async function setInstructions(hub: HubHost, text: string): Promise<ClaudeInstructions & { devices: Record<string, string> }> {
  let info: ClaudeInstructions;
  if (text) {
    const setAt = Date.now();
    await hub.storage.put<StoredInstructions>(INSTRUCTIONS_KEY, { text, setAt });
    info = { text, setAt };
  } else {
    await hub.storage.delete(INSTRUCTIONS_KEY);
    info = { text: "" };
  }
  const devices: Record<string, string> = {};
  await Promise.all(
    hub.devicesWith("claudeInstructions").map(async (id) => {
      const r = await hub.deviceRpc(id, "agent.setInstructions", { instructions: text }, 15_000);
      devices[id] = r.ok ? "ok" : r.message;
    }),
  );
  return { ...info, devices };
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
  return c.json(await callHub(c.env, c.var.user.id, "claude", "setToken", token));
});

/** Forgets the token; devices go back to their own sign-in. */
routes.delete("/token", async (c) => {
  return c.json(await callHub(c.env, c.var.user.id, "claude", "setToken", ""));
});

routes.get("/instructions", async (c) =>
  c.json(await callHub<ClaudeInstructions>(c.env, c.var.user.id, "claude", "instructions")),
);

/** Sets them ("" clears them) and sends them to every connected device; reports what each said. */
routes.put("/instructions", async (c) => {
  const body = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown });
  if (typeof body.text !== "string") return c.json({ error: "give the instructions as text" }, 400);
  const text = body.text.trim();
  if (text.length > MAX_INSTRUCTIONS) {
    return c.json({ error: `instructions can be at most ${MAX_INSTRUCTIONS.toLocaleString("en-US")} characters` }, 400);
  }
  return c.json(await callHub(c.env, c.var.user.id, "claude", "setInstructions", text));
});

export const claude: WorkerPlugin = {
  id: "claude",
  routes: [{ path: "/api/claude", app: routes }],
  legacyStorageKeys: [TOKEN_KEY],
  hubFeatures: ["claudeToken", "claudeInstructions"],
  // A daemon gets the account's Claude token and custom instructions as it connects.
  onDaemonHello: async (hub, deviceId, features) => {
    const tasks: Promise<void>[] = [];
    if (features.includes("claudeToken")) {
      tasks.push(
        (async () => {
          const t = await hub.storage.get<StoredToken>(TOKEN_KEY);
          const token = t ? await open(hub.env, t.sealed) : "";
          const r = await hub.deviceRpc(deviceId, "agent.setToken", { token }, 15_000);
          if (!r.ok) console.warn(`sending ${deviceId} the Claude token: ${r.message}`);
        })(),
      );
    }
    if (features.includes("claudeInstructions")) {
      tasks.push(
        (async () => {
          const { text } = await instructions(hub);
          const r = await hub.deviceRpc(deviceId, "agent.setInstructions", { instructions: text }, 15_000);
          if (!r.ok) console.warn(`sending ${deviceId} the custom instructions: ${r.message}`);
        })(),
      );
    }
    await Promise.all(tasks);
  },
  hubMethods: {
    tokenInfo: (hub) => tokenInfo(hub),
    setToken: (hub, token) => setToken(hub, typeof token === "string" ? token : ""),
    instructions: (hub) => instructions(hub),
    setInstructions: (hub, text) => setInstructions(hub, typeof text === "string" ? text : ""),
  },
};
