import { Hono } from "hono";
import type { Context, Next } from "hono";
import { bearerDevice, createSession, destroySession, sessionUser } from "./auth";
import { hashPassword, randomId, randomToken, sha256, verifyPassword } from "./crypto";
import { HUB_ID_HEADER, HUB_KIND_HEADER } from "./hub";
import { failingScript, installScript } from "./install";
import type { App } from "./types";

export { AccountHub } from "./hub";

const ENROLL_TOKEN_TTL_MS = 15 * 60 * 1000;

const app = new Hono<App>();

async function requireUser(c: Context<App>, next: Next) {
  const user = await sessionUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
}

function hub(env: Env, accountId: string) {
  return env.HUB.get(env.HUB.idFromName(accountId));
}

// --- auth -------------------------------------------------------------------

app.get("/api/auth/me", async (c) => {
  const user = await sessionUser(c);
  const anyUser = await c.env.DB.prepare("SELECT 1 FROM users LIMIT 1").first();
  return c.json({ user, signupOpen: !anyUser });
});

app.post("/api/auth/signup", async (c) => {
  const { username, password } = await c.req.json<{ username?: string; password?: string }>();
  if (!username?.trim() || !password || password.length < 8) {
    return c.json({ error: "username and a password of at least 8 characters are required" }, 400);
  }
  const id = randomId();
  // First signup wins: the insert only happens while the table is empty.
  const res = await c.env.DB.prepare(
    `INSERT INTO users (id, username, password_hash, created_at)
     SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
  )
    .bind(id, username.trim(), await hashPassword(password), Date.now())
    .run();
  if (res.meta.changes !== 1) return c.json({ error: "signup is closed" }, 403);
  await createSession(c, id);
  return c.json({ user: { id, username: username.trim() } });
});

app.post("/api/auth/login", async (c) => {
  const { username, password } = await c.req.json<{ username?: string; password?: string }>();
  const row = await c.env.DB.prepare("SELECT id, username, password_hash FROM users WHERE username = ?")
    .bind(username?.trim() ?? "")
    .first<{ id: string; username: string; password_hash: string }>();
  if (!row || !password || !(await verifyPassword(password, row.password_hash))) {
    return c.json({ error: "invalid username or password" }, 401);
  }
  await createSession(c, row.id);
  return c.json({ user: { id: row.id, username: row.username } });
});

app.post("/api/auth/logout", async (c) => {
  await destroySession(c);
  return c.json({});
});

// --- devices ----------------------------------------------------------------

app.get("/api/devices", requireUser, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, hostname, os, arch, version, created_at AS createdAt, last_seen_at AS lastSeenAt
     FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY name`,
  )
    .bind(c.var.user.id)
    .all();
  return c.json({ devices: results });
});

app.patch("/api/devices/:id", requireUser, async (c) => {
  const { name } = await c.req.json<{ name?: string }>();
  if (!name?.trim()) return c.json({ error: "name is required" }, 400);
  const res = await c.env.DB.prepare(
    "UPDATE devices SET name = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
  )
    .bind(name.trim(), c.req.param("id"), c.var.user.id)
    .run();
  if (res.meta.changes !== 1) return c.json({ error: "not found" }, 404);
  return c.json({});
});

app.delete("/api/devices/:id", requireUser, async (c) => {
  const id = c.req.param("id") ?? "";
  const res = await c.env.DB.prepare(
    "UPDATE devices SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
  )
    .bind(Date.now(), id, c.var.user.id)
    .run();
  if (res.meta.changes !== 1) return c.json({ error: "not found" }, 404);
  await hub(c.env, c.var.user.id).revokeDevice(id);
  return c.json({});
});

// --- enrollment -------------------------------------------------------------

app.post("/api/enroll-tokens", requireUser, async (c) => {
  const token = randomToken();
  const expiresAt = Date.now() + ENROLL_TOKEN_TTL_MS;
  await c.env.DB.prepare("INSERT INTO enroll_tokens (token_hash, account_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), c.var.user.id, expiresAt)
    .run();
  return c.json({ command: `curl -fsSL ${c.env.PUBLIC_URL}/i/${token} | sh`, expiresAt });
});

app.get("/i/:token", async (c) => {
  const token = c.req.param("token");
  const row = await c.env.DB.prepare(
    "SELECT 1 FROM enroll_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(await sha256(token), Date.now())
    .first();
  const script = row
    ? installScript({ server: c.env.PUBLIC_URL, token, repo: c.env.GITHUB_REPO })
    : failingScript("this install link is invalid, used, or expired; generate a new one in the web UI");
  return c.text(script, 200, { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" });
});

app.post("/api/daemon/enroll", async (c) => {
  const body = await c.req.json<{ token?: string; hostname?: string; os?: string; arch?: string; version?: string }>();
  if (!body.token || !body.hostname) return c.json({ error: "token and hostname are required" }, 400);
  const tokenHash = await sha256(body.token);
  const deviceId = randomId();
  const now = Date.now();
  // Consume the token atomically so a link can only ever enroll one device.
  const claim = await c.env.DB.prepare(
    `UPDATE enroll_tokens SET used_at = ?, device_id = ?
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING account_id`,
  )
    .bind(now, deviceId, tokenHash, now)
    .first<{ account_id: string }>();
  if (!claim) return c.json({ error: "install link is invalid, used, or expired" }, 403);

  const credential = randomToken();
  await c.env.DB.prepare(
    `INSERT INTO devices (id, account_id, name, hostname, os, arch, version, credential_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      deviceId,
      claim.account_id,
      body.hostname,
      body.hostname,
      body.os ?? "linux",
      body.arch ?? "unknown",
      body.version ?? "unknown",
      await sha256(credential),
      now,
    )
    .run();
  return c.json({ deviceId, credential });
});

// --- hub websockets ---------------------------------------------------------

app.get("/api/ws", requireUser, async (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.text("expected websocket", 426);
  const headers = new Headers(c.req.raw.headers);
  headers.set(HUB_KIND_HEADER, "client");
  return hub(c.env, c.var.user.id).fetch(new Request(c.req.raw, { headers }));
});

app.get("/api/daemon/ws", async (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.text("expected websocket", 426);
  const device = await bearerDevice(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const version = c.req.header("x-ew-version") ?? "unknown";
  await c.env.DB.prepare("UPDATE devices SET version = ? WHERE id = ?").bind(version, device.id).run();
  const headers = new Headers(c.req.raw.headers);
  headers.set(HUB_KIND_HEADER, "device");
  headers.set(HUB_ID_HEADER, device.id);
  return hub(c.env, device.account_id).fetch(new Request(c.req.raw, { headers }));
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default app;
