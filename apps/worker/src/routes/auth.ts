import { Hono } from "hono";
import type { Context, Next } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import {
  checkPassword,
  createSession,
  passwordProblem,
  SESSION_COOKIE,
  sessionUser,
} from "../auth";
import { hashPassword, randomId, randomToken, sha256 } from "../crypto";
import { open, seal } from "../secretbox";
import { clientIp, rateLimited, tooMany } from "../security";
import {
  generateRecoveryCode,
  generateSecret,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "../totp";
import type { App } from "../types";

const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MFA_MAX_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;
const ISSUER = "everywhere";

export async function requireUser(c: Context<App>, next: Next) {
  const s = await sessionUser(c);
  if (!s) return c.json({ error: "unauthorized" }, 401);
  c.set("user", s.user);
  c.set("sessionId", s.sessionId);
  await next();
}

async function body<T>(c: Context<App>): Promise<Partial<T>> {
  try {
    return await c.req.json<Partial<T>>();
  } catch {
    return {};
  }
}

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  totp_pending: string | null;
  totp_last_step: number | null;
}

export async function userRow(env: Env, id: string): Promise<UserRow> {
  const row = await env.DB.prepare(
    "SELECT id, username, password_hash, totp_secret, totp_pending, totp_last_step FROM users WHERE id = ?",
  )
    .bind(id)
    .first<UserRow>();
  if (!row) throw new Error("user vanished");
  return row;
}

/** Checks a TOTP code (no replays) or consumes a recovery code. */
export async function verifySecondFactor(env: Env, user: UserRow, code: string): Promise<boolean> {
  code = code.trim();
  if (/^\d{6}$/.test(code)) {
    if (!user.totp_secret) return false;
    const step = await verifyTotp(await open(env, user.totp_secret), code);
    if (step === null) return false;
    const res = await env.DB.prepare(
      "UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)",
    )
      .bind(step, user.id, step)
      .run();
    return res.meta.changes === 1;
  }
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== 10) return false;
  const res = await env.DB.prepare(
    "UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND user_id = ? AND used_at IS NULL",
  )
    .bind(Date.now(), await sha256(normalized), user.id)
    .run();
  return res.meta.changes === 1;
}

async function recoveryCodeBatch(env: Env, userId: string): Promise<{ codes: string[]; stmts: D1PreparedStatement[] }> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const hashes = await Promise.all(codes.map((code) => sha256(normalizeRecoveryCode(code))));
  return {
    codes,
    stmts: [
      env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId),
      ...hashes.map((h) => env.DB.prepare("INSERT INTO recovery_codes (code_hash, user_id) VALUES (?, ?)").bind(h, userId)),
    ],
  };
}

async function newRecoveryCodes(env: Env, userId: string): Promise<string[]> {
  const { codes, stmts } = await recoveryCodeBatch(env, userId);
  await env.DB.batch(stmts);
  return codes;
}

/** Revokes sessions and closes their hub sockets (and any WebRTC peers they opened). */
async function revokeSessions(env: Env, userId: string, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  await env.DB.batch(sessionIds.map((id) => env.DB.prepare("DELETE FROM sessions WHERE id_hash = ? AND user_id = ?").bind(id, userId)));
  await closeSockets(env, userId, sessionIds);
}

/** Closes the hub sockets that sessions opened. */
async function closeSockets(env: Env, userId: string, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  await env.HUB.get(env.HUB.idFromName(userId)).revokeSessions(sessionIds);
}

/** The user as the web app sees it (same shape as /me). */
async function publicUser(env: Env, id: string) {
  const row = await env.DB.prepare(
    `SELECT id, username, totp_secret IS NOT NULL AS totp,
       (SELECT COUNT(*) FROM recovery_codes r WHERE r.user_id = users.id AND r.used_at IS NULL) AS codes
     FROM users WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string; username: string; totp: number; codes: number }>();
  if (!row) throw new Error("user vanished");
  return { id: row.id, username: row.username, totpEnabled: row.totp === 1, recoveryCodesLeft: row.codes };
}

export const auth = new Hono<App>();

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

auth.get("/me", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    const anyUser = await c.env.DB.prepare("SELECT 1 FROM users LIMIT 1").first();
    return c.json({ user: null, signupOpen: !anyUser });
  }
  const sessionId = await sha256(token);
  const now = Date.now();
  const [sessRes, anyRes] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT u.id, u.username, u.totp_secret IS NOT NULL AS totp, s.last_seen_at,
         (SELECT COUNT(*) FROM recovery_codes r WHERE r.user_id = u.id AND r.used_at IS NULL) AS codes
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ?`,
    ).bind(sessionId, now),
    c.env.DB.prepare("SELECT 1 AS one FROM users LIMIT 1"),
  ]);
  const row = (sessRes!.results as { id: string; username: string; totp: number; last_seen_at: number | null; codes: number }[])[0];
  if (!row) {
    return c.json({ user: null, signupOpen: anyRes!.results.length === 0 });
  }
  if (!row.last_seen_at || now - row.last_seen_at > TOUCH_INTERVAL_MS) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(now, sessionId).run(),
    );
  }
  return c.json({
    user: { id: row.id, username: row.username, totpEnabled: row.totp === 1, recoveryCodesLeft: row.codes },
    signupOpen: false,
  });
});

auth.post("/signup", async (c) => {
  if (await rateLimited(c, `signup:${clientIp(c)}`)) return tooMany(c);
  const { username, password } = await body<{ username: string; password: string }>(c);
  const name = typeof username === "string" ? username.trim() : "";
  if (!name || name.length > 64) return c.json({ error: "username is required (max 64 characters)" }, 400);
  const problem = passwordProblem(password);
  if (problem) return c.json({ error: problem }, 400);
  const id = randomId();
  // First signup wins: the insert only happens while the table is empty.
  const res = await c.env.DB.prepare(
    `INSERT INTO users (id, username, password_hash, created_at)
     SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
  )
    .bind(id, name, await hashPassword(password!), Date.now())
    .run();
  if (res.meta.changes !== 1) return c.json({ error: "signup is closed" }, 403);
  await createSession(c, id);
  return c.json({ user: { id, username: name, totpEnabled: false, recoveryCodesLeft: 0 } });
});

auth.post("/login", async (c) => {
  const { username, password } = await body<{ username: string; password: string }>(c);
  const name = typeof username === "string" ? username.trim() : "";
  // Per IP, and per username across IPs.
  if (await rateLimited(c, `login:${clientIp(c)}`, `login-user:${name.toLowerCase()}`)) return tooMany(c);
  if (typeof password !== "string" || password.length > 256) {
    return c.json({ error: "invalid username or password" }, 401);
  }
  const row = await c.env.DB.prepare("SELECT id, username, password_hash, totp_secret FROM users WHERE username = ?")
    .bind(name)
    .first<{ id: string; username: string; password_hash: string; totp_secret: string | null }>();
  if (!(await checkPassword(row?.password_hash, password)) || !row) {
    return c.json({ error: "invalid username or password" }, 401);
  }
  if (row.totp_secret) {
    const challenge = randomToken();
    await c.env.DB.prepare("INSERT INTO mfa_challenges (id_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256(challenge), row.id, Date.now() + MFA_CHALLENGE_TTL_MS)
      .run();
    return c.json({ mfaRequired: true, challenge });
  }
  await createSession(c, row.id);
  return c.json({ user: { id: row.id, username: row.username, totpEnabled: false, recoveryCodesLeft: 0 } });
});

auth.post("/login/mfa", async (c) => {
  if (await rateLimited(c, `mfa:${clientIp(c)}`)) return tooMany(c);
  const { challenge, code } = await body<{ challenge: string; code: string }>(c);
  if (typeof challenge !== "string" || typeof code !== "string") return c.json({ error: "code is required" }, 400);
  const idHash = await sha256(challenge);
  // Count the attempt before checking, so parallel guesses can't exceed the cap.
  const claim = await c.env.DB.prepare(
    `UPDATE mfa_challenges SET attempts = attempts + 1
     WHERE id_hash = ? AND attempts < ? AND expires_at > ? RETURNING user_id`,
  )
    .bind(idHash, MFA_MAX_ATTEMPTS, Date.now())
    .first<{ user_id: string }>();
  if (!claim) {
    await c.env.DB.prepare("DELETE FROM mfa_challenges WHERE id_hash = ?").bind(idHash).run();
    return c.json({ error: "sign-in expired or too many attempts; enter your password again", expired: true }, 401);
  }
  const user = await userRow(c.env, claim.user_id);
  if (!(await verifySecondFactor(c.env, user, code))) return c.json({ error: "invalid code" }, 401);
  await c.env.DB.prepare("DELETE FROM mfa_challenges WHERE id_hash = ? OR expires_at < ?").bind(idHash, Date.now()).run();
  await createSession(c, user.id);
  return c.json({ user: await publicUser(c.env, user.id) });
});

auth.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  if (token) {
    const sessionId = await sha256(token);
    const deleted = await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ? RETURNING user_id")
      .bind(sessionId)
      .first<{ user_id: string }>();
    if (deleted) await closeSockets(c.env, deleted.user_id, [sessionId]);
  }
  return c.json({});
});

// --- signed-in account management ---------------------------------------------

auth.post("/password", requireUser, async (c) => {
  if (await rateLimited(c, `password:${c.var.user.id}`)) return tooMany(c);
  const { currentPassword, newPassword } = await body<{ currentPassword: string; newPassword: string }>(c);
  const user = await userRow(c.env, c.var.user.id);
  if (typeof currentPassword !== "string" || !(await checkPassword(user.password_hash, currentPassword))) {
    return c.json({ error: "current password is incorrect" }, 403);
  }
  const problem = passwordProblem(newPassword);
  if (problem) return c.json({ error: problem }, 400);
  const newHash = await hashPassword(newPassword!);
  const [, deletedSessions] = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(newHash, user.id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ? RETURNING id_hash").bind(
      user.id,
      c.var.sessionId,
    ),
    // Connected agents' keys go too, like every other session.
    c.env.DB.prepare("DELETE FROM agent_keys WHERE user_id = ?").bind(user.id),
  ]);
  const revoked = (deletedSessions!.results as { id_hash: string }[]).map((r) => r.id_hash);
  await closeSockets(c.env, user.id, revoked);
  return c.json({});
});

auth.post("/2fa/setup", requireUser, async (c) => {
  if (await rateLimited(c, `2fa:${c.var.user.id}`)) return tooMany(c);
  const { password } = await body<{ password: string }>(c);
  const user = await userRow(c.env, c.var.user.id);
  if (user.totp_secret) return c.json({ error: "two-factor authentication is already enabled" }, 409);
  if (typeof password !== "string" || !(await checkPassword(user.password_hash, password))) {
    return c.json({ error: "password is incorrect" }, 403);
  }
  const secret = generateSecret();
  await c.env.DB.prepare("UPDATE users SET totp_pending = ? WHERE id = ?").bind(await seal(c.env, secret), user.id).run();
  return c.json({ secret, otpauthUri: otpauthUri(secret, user.username, ISSUER) });
});

auth.post("/2fa/enable", requireUser, async (c) => {
  if (await rateLimited(c, `2fa:${c.var.user.id}`)) return tooMany(c);
  const { code } = await body<{ code: string }>(c);
  const user = await userRow(c.env, c.var.user.id);
  if (!user.totp_pending) return c.json({ error: "start setup first" }, 409);
  const step = typeof code === "string" ? await verifyTotp(await open(c.env, user.totp_pending), code.trim()) : null;
  if (step === null) return c.json({ error: "invalid code; check your authenticator's clock" }, 400);
  const { codes, stmts } = await recoveryCodeBatch(c.env, user.id);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ? WHERE id = ?").bind(
      step,
      user.id,
    ),
    ...stmts,
  ]);
  return c.json({ recoveryCodes: codes });
});

auth.post("/2fa/disable", requireUser, async (c) => {
  if (await rateLimited(c, `2fa:${c.var.user.id}`)) return tooMany(c);
  const { password, code } = await body<{ password: string; code: string }>(c);
  const user = await userRow(c.env, c.var.user.id);
  if (!user.totp_secret) return c.json({ error: "two-factor authentication is not enabled" }, 409);
  if (typeof password !== "string" || !(await checkPassword(user.password_hash, password))) {
    return c.json({ error: "password is incorrect" }, 403);
  }
  if (typeof code !== "string" || !(await verifySecondFactor(c.env, user, code))) {
    return c.json({ error: "invalid code" }, 403);
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL WHERE id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(user.id),
  ]);
  return c.json({});
});

auth.post("/2fa/recovery-codes", requireUser, async (c) => {
  if (await rateLimited(c, `2fa:${c.var.user.id}`)) return tooMany(c);
  const { code } = await body<{ code: string }>(c);
  const user = await userRow(c.env, c.var.user.id);
  if (!user.totp_secret) return c.json({ error: "two-factor authentication is not enabled" }, 409);
  if (typeof code !== "string" || !/^\d{6}$/.test(code.trim()) || !(await verifySecondFactor(c.env, user, code))) {
    return c.json({ error: "enter a current code from your authenticator app" }, 403);
  }
  return c.json({ recoveryCodes: await newRecoveryCodes(c.env, user.id) });
});

auth.get("/sessions", requireUser, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id_hash, created_at, last_seen_at, user_agent FROM sessions
     WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`,
  )
    .bind(c.var.user.id, Date.now())
    .all<{ id_hash: string; created_at: number | null; last_seen_at: number | null; user_agent: string | null }>();
  return c.json({
    sessions: results.map((r) => ({
      id: r.id_hash,
      current: r.id_hash === c.var.sessionId,
      createdAt: r.created_at ?? 0,
      lastSeenAt: r.last_seen_at ?? r.created_at ?? 0,
      userAgent: r.user_agent,
    })),
  });
});

auth.delete("/sessions/:id", requireUser, async (c) => {
  const id = c.req.param("id") ?? "";
  if (id === c.var.sessionId) return c.json({ error: "use sign out for the current session" }, 400);
  await revokeSessions(c.env, c.var.user.id, [id]);
  return c.json({});
});

auth.post("/sessions/revoke-others", requireUser, async (c) => {
  const { results } = await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ? RETURNING id_hash")
    .bind(c.var.user.id, c.var.sessionId)
    .all<{ id_hash: string }>();
  await closeSockets(c.env, c.var.user.id, results.map((r) => r.id_hash));
  return c.json({});
});
