import { Hono } from "hono";
import { bearerDevice } from "./auth";
import { randomId, randomToken, sha256 } from "./crypto";
import { HUB_ID_HEADER, HUB_KIND_HEADER, HUB_SESSION_HEADER } from "./hub";
import { failingScript, installScript } from "./install";
import { mcp } from "./mcp";
import { oauth } from "./oauth";
import { auth, requireUser } from "./routes/auth";
import { push } from "./routes/push";
import { iceServers, TURN_TTL_SECONDS } from "./turn";
import { apiGuard, clientIp, originAllowed, rateLimited, tooMany } from "./security";
import type { App } from "./types";

export { AccountHub } from "./hub";

const ENROLL_TOKEN_TTL_MS = 15 * 60 * 1000;

const app = new Hono<App>();

app.use("/api/*", apiGuard);
app.route("/api/auth", auth);
app.route("/api/push", push);
// The MCP endpoint for agents, and the OAuth server that authorizes them.
app.route("/", oauth);
app.route("/", mcp);

function hub(env: Env, accountId: string) {
  return env.HUB.get(env.HUB.idFromName(accountId));
}

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

// --- connected apps (OAuth grants for the MCP endpoint) ----------------------

app.get("/api/connections", requireUser, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT g.id, c.name, c.redirect_uris, g.created_at AS createdAt, g.last_used_at AS lastUsedAt
     FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
     WHERE g.user_id = ? ORDER BY g.created_at DESC`,
  )
    .bind(c.var.user.id)
    .all<{ id: string; name: string; redirect_uris: string; createdAt: number; lastUsedAt: number | null }>();
  return c.json({
    mcpUrl: `${c.env.PUBLIC_URL}/mcp`,
    connections: results.map(({ redirect_uris, ...r }) => ({
      ...r,
      // Where the app said it lives; client names are self-reported.
      hosts: [...new Set((JSON.parse(redirect_uris) as string[]).map((u) => new URL(u).host))],
    })),
  });
});

app.delete("/api/connections/:id", requireUser, async (c) => {
  // RETURNING, not meta.changes: D1 counts the cascaded token rows too.
  const row = await c.env.DB.prepare("DELETE FROM oauth_grants WHERE id = ? AND user_id = ? RETURNING id")
    .bind(c.req.param("id"), c.var.user.id)
    .first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({});
});

// --- WebRTC -------------------------------------------------------------------

app.get("/api/ice-servers", requireUser, async (c) => {
  if (await rateLimited(c, `ice:${c.var.user.id}`)) return tooMany(c);
  const { iceServers: servers, turn } = await iceServers(c.env);
  return c.json({ iceServers: servers, turn, expiresAt: Date.now() + TURN_TTL_SECONDS * 1000 });
});

// Daemons get relay candidates too, for networks that block the UDP ports a
// browser's relay would send to (strict corporate/campus egress).
app.get("/api/daemon/ice-servers", async (c) => {
  const device = await bearerDevice(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  if (await rateLimited(c, `ice:${device.id}`)) return tooMany(c);
  const { iceServers: servers, turn } = await iceServers(c.env);
  return c.json({ iceServers: servers, turn, expiresAt: Date.now() + TURN_TTL_SECONDS * 1000 });
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
  if (await rateLimited(c, `install:${clientIp(c)}`)) {
    return c.text(failingScript("too many requests; wait a minute"), 429);
  }
  const token = c.req.param("token");
  const row = await c.env.DB.prepare(
    "SELECT 1 FROM enroll_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(await sha256(token), Date.now())
    .first();
  const script = row
    ? installScript({ server: c.env.PUBLIC_URL, token, repo: c.env.GITHUB_REPO })
    : failingScript("this install link is invalid, used, or expired; generate a new one in the web UI");
  return c.text(script, 200, {
    "content-type": "text/x-shellscript; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
});

app.post("/api/daemon/enroll", async (c) => {
  if (await rateLimited(c, `enroll:${clientIp(c)}`)) return tooMany(c);
  const body = await c.req.json<{ token?: string; hostname?: string; os?: string; arch?: string; version?: string }>();
  if (typeof body.token !== "string" || typeof body.hostname !== "string" || !body.hostname) {
    return c.json({ error: "token and hostname are required" }, 400);
  }
  const clip = (v: unknown, fallback: string) => (typeof v === "string" && v ? v.slice(0, 64) : fallback);
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
      clip(body.hostname, "device"),
      clip(body.hostname, "device"),
      clip(body.os, "linux"),
      clip(body.arch, "unknown"),
      clip(body.version, "unknown"),
      await sha256(credential),
      now,
    )
    .run();
  return c.json({ deviceId, credential });
});

// --- hub websockets ---------------------------------------------------------

app.get("/api/ws", requireUser, async (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.text("expected websocket", 426);
  // Browsers always send Origin on WebSocket handshakes; cookies alone would
  // let another site (or another *.replogle.dev subdomain) hijack the socket.
  if (!originAllowed(c)) return c.json({ error: "cross-origin websocket rejected" }, 403);
  const headers = new Headers(c.req.raw.headers);
  headers.set(HUB_KIND_HEADER, "client");
  headers.set(HUB_SESSION_HEADER, c.var.sessionId);
  return hub(c.env, c.var.user.id).fetch(new Request(c.req.raw, { headers }));
});

app.get("/api/daemon/ws", async (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.text("expected websocket", 426);
  const device = await bearerDevice(c);
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const version = (c.req.header("x-ew-version") ?? "unknown").slice(0, 64);
  await c.env.DB.prepare("UPDATE devices SET version = ? WHERE id = ?").bind(version, device.id).run();
  const headers = new Headers(c.req.raw.headers);
  headers.set(HUB_KIND_HEADER, "device");
  headers.set(HUB_ID_HEADER, device.id);
  return hub(c.env, device.account_id).fetch(new Request(c.req.raw, { headers }));
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default app;
