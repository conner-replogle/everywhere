import { Hono } from "hono";
import type { App } from "../types";
import { requireUser } from "./auth";

// The account's Claude token: one made with `claude setup-token`, which every
// device's daemon gives claude (CLAUDE_CODE_OAUTH_TOKEN) instead of signing
// in and renewing on its own. The hub keeps it sealed and sends it to
// daemons; the web app only ever sees its last few characters.

export const claude = new Hono<App>();

claude.use("*", requireUser);

const hub = (env: Env, userId: string) => env.HUB.get(env.HUB.idFromName(userId));

/** A setup-token token, or a key: what claude accepts there. */
const TOKEN = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

claude.get("/token", async (c) => c.json(await hub(c.env, c.var.user.id).claudeTokenInfo()));

/** Sets the token and sends it to every connected device; reports what each said. */
claude.put("/token", async (c) => {
  const body = await c.req.json<{ token?: unknown }>().catch(() => ({}) as { token?: unknown });
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!TOKEN.test(token)) {
    return c.json({ error: "that isn't a Claude token; `claude setup-token` prints one starting sk-ant-oat01-" }, 400);
  }
  const h = hub(c.env, c.var.user.id);
  const devices = await h.setClaudeToken(token);
  return c.json({ ...(await h.claudeTokenInfo()), devices });
});

/** Forgets the token; devices go back to their own sign-in. */
claude.delete("/token", async (c) => {
  const h = hub(c.env, c.var.user.id);
  const devices = await h.setClaudeToken("");
  return c.json({ ...(await h.claudeTokenInfo()), devices });
});
