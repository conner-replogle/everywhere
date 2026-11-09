// Connected agents' switch and API keys (Settings → Connected agents). The
// switch is off until the user turns it on with their password; a key, made
// with the password too, reaches only the devices and scopes ticked for it,
// and expires. Turning the switch off deletes every key.
import { Hono } from "hono";
import type { Context } from "hono";
import { randomId, randomToken, sha256 } from "../crypto";
import { checkPassword } from "../auth";
import { requireUser, userRow, verifySecondFactor } from "../routes/auth";
import { rateLimited, tooMany } from "../security";
import type { App } from "../types";

/** read: see devices, projects and threads. drive: prompt, start, stop and change threads. projects: add projects. */
export const SCOPES = ["read", "drive", "projects"] as const;
export type Scope = (typeof SCOPES)[number];

const EXPIRY_DAYS = [7, 30, 90] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const KEY_PREFIX = "ewk_";
/** Activity older than this is dropped. */
const ACTIVITY_KEEP_MS = 90 * DAY_MS;

export function parseScopes(s: string | null | undefined): Scope[] {
  const words = new Set((s ?? "").split(/\s+/));
  return SCOPES.filter((x) => words.has(x));
}

function parseDevices(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function mcpUrl(env: Env): string {
  return `${env.PUBLIC_URL}/mcp`;
}

/** Whether anyone turned connected agents on (the Worker is single-account). */
export async function agentsOn(env: Env): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM users WHERE agents_enabled_at IS NOT NULL LIMIT 1").first());
}

// --- bearer keys ------------------------------------------------------------------

/** Who a connected agent's request is from, and what its key allows. */
export interface AgentCaller {
  userId: string;
  keyId: string;
  /** The key's name, shown with the prompts it sends. */
  name: string;
  scopes: Scope[];
  /** Device ids it may reach. */
  devices: string[];
}

/** Resolves `Authorization: Bearer ewk_…` to a live key of an account with connected agents on. */
export async function bearerAgent(c: Context<App>): Promise<AgentCaller | null> {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith(KEY_PREFIX) || token.length > 200) return null;
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT k.id, k.user_id, k.name, k.scopes, k.devices, k.last_used_at
     FROM agent_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = ? AND k.expires_at > ? AND u.agents_enabled_at IS NOT NULL`,
  )
    .bind(await sha256(token), now)
    .first<{ id: string; user_id: string; name: string; scopes: string; devices: string; last_used_at: number | null }>();
  if (!row) return null;
  if (!row.last_used_at || now - row.last_used_at > TOUCH_INTERVAL_MS) {
    c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE agent_keys SET last_used_at = ? WHERE id = ?").bind(now, row.id).run());
  }
  return { userId: row.user_id, keyId: row.id, name: row.name, scopes: parseScopes(row.scopes), devices: parseDevices(row.devices) };
}

/** Records a tool call for the activity list. */
export async function logActivity(
  env: Env,
  who: AgentCaller,
  entry: { tool: string; deviceId?: string; threadId?: string; ok: boolean; error?: string },
): Promise<void> {
  const now = Date.now();
  const stmts = [
    env.DB.prepare(
      `INSERT INTO agent_activity (id, user_id, key_id, key_name, tool, device_id, thread_id, ok, error, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      randomId(),
      who.userId,
      who.keyId,
      who.name,
      entry.tool.slice(0, 64),
      entry.deviceId?.slice(0, 64) ?? null,
      entry.threadId?.slice(0, 64) ?? null,
      entry.ok ? 1 : 0,
      entry.error?.slice(0, 500) ?? null,
      now,
    ),
  ];
  // Now and then, forget what's old.
  if (Math.random() < 0.02) {
    stmts.push(env.DB.prepare("DELETE FROM agent_activity WHERE user_id = ? AND at < ?").bind(who.userId, now - ACTIVITY_KEEP_MS));
  }
  await env.DB.batch(stmts);
}

// --- settings routes -----------------------------------------------------------------

export const agentSettings = new Hono<App>();

agentSettings.use("*", requireUser);

interface KeyRow {
  id: string;
  name: string;
  hint: string;
  scopes: string;
  devices: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
}

function keyJson(k: KeyRow) {
  return {
    id: k.id,
    name: k.name,
    hint: k.hint,
    scopes: parseScopes(k.scopes),
    devices: parseDevices(k.devices),
    createdAt: k.created_at,
    expiresAt: k.expires_at,
    ...(k.last_used_at ? { lastUsedAt: k.last_used_at } : {}),
  };
}

async function body<T>(c: Context<App>): Promise<Partial<T>> {
  return (await c.req.json().catch(() => ({}))) as Partial<T>;
}

/**
 * Checks the password, and the second factor when the account has one. A
 * Response when they don't pass.
 */
async function reauth(c: Context<App>, password: unknown, code: unknown): Promise<Response | null> {
  if (await rateLimited(c, `agents-auth:${c.var.user.id}`)) return tooMany(c);
  const user = await userRow(c.env, c.var.user.id);
  if (typeof password !== "string" || !(await checkPassword(user.password_hash, password))) {
    return c.json({ error: "wrong password" }, 401);
  }
  if (user.totp_secret) {
    if (typeof code !== "string" || !code.trim()) return c.json({ error: "enter a code from your authenticator app", needsCode: true }, 401);
    if (!(await verifySecondFactor(c.env, user, code))) return c.json({ error: "that code didn't work", needsCode: true }, 401);
  }
  return null;
}

agentSettings.get("/", async (c) => {
  const [user, { results }] = await Promise.all([
    c.env.DB.prepare("SELECT agents_enabled_at FROM users WHERE id = ?")
      .bind(c.var.user.id)
      .first<{ agents_enabled_at: number | null }>(),
    c.env.DB.prepare(
      `SELECT id, name, hint, scopes, devices, created_at, expires_at, last_used_at FROM agent_keys
       WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC`,
    )
      .bind(c.var.user.id, Date.now())
      .all<KeyRow>(),
  ]);
  return c.json({
    enabled: user?.agents_enabled_at != null,
    ...(user?.agents_enabled_at ? { enabledAt: user.agents_enabled_at } : {}),
    mcpUrl: mcpUrl(c.env),
    keys: results.map(keyJson),
  });
});

agentSettings.post("/enable", async (c) => {
  const { password, code } = await body<{ password: string; code: string }>(c);
  const denied = await reauth(c, password, code);
  if (denied) return denied;
  await c.env.DB.prepare("UPDATE users SET agents_enabled_at = COALESCE(agents_enabled_at, ?) WHERE id = ?")
    .bind(Date.now(), c.var.user.id)
    .run();
  return c.json({ enabled: true });
});

agentSettings.post("/disable", async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET agents_enabled_at = NULL WHERE id = ?").bind(c.var.user.id),
    c.env.DB.prepare("DELETE FROM agent_keys WHERE user_id = ?").bind(c.var.user.id),
  ]);
  return c.json({});
});

agentSettings.post("/keys", async (c) => {
  const b = await body<{ name: string; scopes: unknown; devices: unknown; expiresInDays: number; password: string; code: string }>(c);
  const userId = c.var.user.id;
  const on = await c.env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND agents_enabled_at IS NOT NULL").bind(userId).first();
  if (!on) return c.json({ error: "turn connected agents on first" }, 400);
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : "";
  if (!name) return c.json({ error: "give the key a name" }, 400);
  const days = EXPIRY_DAYS.find((d) => d === b.expiresInDays);
  if (!days) return c.json({ error: `expiresInDays must be one of ${EXPIRY_DAYS.join(", ")}` }, 400);
  const scopes = new Set<Scope>(["read", ...parseScopes(Array.isArray(b.scopes) ? b.scopes.join(" ") : "")]);
  const { results: owned } = await c.env.DB.prepare("SELECT id FROM devices WHERE account_id = ? AND revoked_at IS NULL")
    .bind(userId)
    .all<{ id: string }>();
  const ownedIds = new Set(owned.map((d) => d.id));
  const devices = [...new Set(Array.isArray(b.devices) ? b.devices : [])].filter(
    (d): d is string => typeof d === "string" && ownedIds.has(d),
  );
  if (devices.length === 0) return c.json({ error: "pick at least one device" }, 400);
  const denied = await reauth(c, b.password, b.code);
  if (denied) return denied;

  const secret = `${KEY_PREFIX}${randomToken()}`;
  const now = Date.now();
  const row: KeyRow = {
    id: randomId(),
    name,
    hint: secret.slice(-4),
    scopes: SCOPES.filter((s) => scopes.has(s)).join(" "),
    devices: JSON.stringify(devices),
    created_at: now,
    expires_at: now + days * DAY_MS,
    last_used_at: null,
  };
  await c.env.DB.prepare(
    `INSERT INTO agent_keys (id, user_id, name, key_hash, hint, scopes, devices, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(row.id, userId, row.name, await sha256(secret), row.hint, row.scopes, row.devices, row.created_at, row.expires_at)
    .run();
  return c.json({ key: keyJson(row), secret });
});

agentSettings.delete("/keys/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM agent_keys WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.var.user.id)
    .run();
  if (res.meta.changes !== 1) return c.json({ error: "not found" }, 404);
  return c.json({});
});

/** Newest first. The cursor is "<at>:<id>" of the last entry seen. */
agentSettings.get("/activity", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 30, 1), 100);
  const cursor = /^(\d+):([A-Za-z0-9_-]+)$/.exec(c.req.query("cursor") ?? "");
  const before = cursor ? Number(cursor[1]) : Number.MAX_SAFE_INTEGER;
  const beforeId = cursor ? cursor[2]! : "";
  const { results } = await c.env.DB.prepare(
    `SELECT id, at, key_id, key_name, tool, device_id, thread_id, ok, error FROM agent_activity
     WHERE user_id = ? AND (at < ? OR (at = ? AND id < ?))
     ORDER BY at DESC, id DESC LIMIT ?`,
  )
    .bind(c.var.user.id, before, before, beforeId, limit + 1)
    .all<{
      id: string;
      at: number;
      key_id: string;
      key_name: string;
      tool: string;
      device_id: string | null;
      thread_id: string | null;
      ok: number;
      error: string | null;
    }>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({
    entries: page.map((r) => ({
      id: r.id,
      at: r.at,
      keyId: r.key_id,
      key: r.key_name,
      tool: r.tool,
      ...(r.device_id ? { deviceId: r.device_id } : {}),
      ...(r.thread_id ? { threadId: r.thread_id } : {}),
      ok: r.ok === 1,
      ...(r.error ? { error: r.error } : {}),
    })),
    ...(results.length > limit && last ? { next: `${last.at}:${last.id}` } : {}),
  });
});
