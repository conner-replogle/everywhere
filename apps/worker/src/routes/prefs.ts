import { Hono } from "hono";
import type { App } from "../types";
import { requireUser } from "./auth";

// Account preferences, shared by every browser the user signs in on.

export interface Prefs {
  /** The permission mode new claude threads start in. */
  defaultPermissionMode?: "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";
  /** Ask claude for a recap when returning to an idle thread. */
  autoRecap?: boolean;
}

const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);

export const prefs = new Hono<App>();

prefs.use("*", requireUser);

async function load(env: Env, userId: string): Promise<Prefs> {
  const row = await env.DB.prepare("SELECT prefs FROM users WHERE id = ?").bind(userId).first<{ prefs: string }>();
  try {
    return JSON.parse(row?.prefs ?? "{}") as Prefs;
  } catch {
    return {};
  }
}

prefs.get("/", async (c) => c.json({ prefs: await load(c.env, c.var.user.id) }));

/** Merges the given keys into the stored preferences. */
prefs.patch("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const next = await load(c.env, c.var.user.id);
  if ("defaultPermissionMode" in body) {
    const mode = body.defaultPermissionMode;
    if (typeof mode !== "string" || !PERMISSION_MODES.has(mode)) {
      return c.json({ error: "unknown permission mode" }, 400);
    }
    next.defaultPermissionMode = mode as Prefs["defaultPermissionMode"];
  }
  if ("autoRecap" in body) {
    if (typeof body.autoRecap !== "boolean") return c.json({ error: "autoRecap must be true or false" }, 400);
    next.autoRecap = body.autoRecap;
  }
  await c.env.DB.prepare("UPDATE users SET prefs = ? WHERE id = ?").bind(JSON.stringify(next), c.var.user.id).run();
  return c.json({ prefs: next });
});
