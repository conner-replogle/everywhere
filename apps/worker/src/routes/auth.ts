import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  checkPassword,
  createSession,
  destroySession,
  passwordProblem,
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

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  totp_pending: string | null;
  totp_last_step: number | null;
}

async function userRow(env: Env, id: string): Promise<UserRow> {
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  if (!row) throw new Error("user vanished");
  return row;
}

/** Checks a TOTP code (no replays) or consumes a recovery code. */
async function verifySecondFactor(env: Env, user: UserRow, code: string): Promise<boolean> {
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

async function newRecoveryCodes(env: Env, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const hashes = await Promise.all(codes.map((code) => sha256(normalizeRecoveryCode(code))));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId),
    ...hashes.map((h) => env.DB.prepare("INSERT INTO recovery_codes (code_hash, user_id) VALUES (?, ?)").bind(h, userId)),
  ]);
  return codes;
}

/** Revokes sessions and closes their hub sockets (and any WebRTC peers they opened). */
async function revokeSessions(env: Env, userId: string, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  await env.DB.batch(sessionIds.map((id) => env.DB.prepare("DELETE FROM sessions WHERE id_hash = ? AND user_id = ?").bind(id, userId)));
  await env.HUB.get(env.HUB.idFromName(userId)).revokeSessions(sessionIds);
}

async function otherSessionIds(env: Env, userId: string, keep: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT id_hash FROM sessions WHERE user_id = ? AND id_hash != ?")
    .bind(userId, keep)
    .all<{ id_hash: string }>();
  return results.map((r) => r.id_hash);
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

auth.get("/me", async (c) => {
  const s = await sessionUser(c);
  const anyUser = await c.env.DB.prepare("SELECT 1 FROM users LIMIT 1").first();
  return c.json({ user: s ? await publicUser(c.env, s.user.id) : null, signupOpen: !anyUser });
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
  return c.json({ user: await publicUser(c.env, row.id) });
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
  const s = await sessionUser(c);
  await destroySession(c);
  if (s) await c.env.HUB.get(c.env.HUB.idFromName(s.user.id)).revokeSessions([s.sessionId]);
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
  await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(await hashPassword(newPassword!), user.id)
    .run();
  await revokeSessions(c.env, user.id, await otherSessionIds(c.env, user.id, c.var.sessionId));
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
  await c.env.DB.prepare(
    "UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ? WHERE id = ?",
  )
    .bind(step, user.id)
    .run();
  return c.json({ recoveryCodes: await newRecoveryCodes(c.env, user.id) });
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
  await revokeSessions(c.env, c.var.user.id, await otherSessionIds(c.env, c.var.user.id, c.var.sessionId));
  return c.json({});
});
