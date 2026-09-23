import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto";
import type { App, User } from "./types";

// __Host- prefix: the browser only accepts it with Secure, Path=/ and no Domain,
// so no other *.replogle.dev subdomain can set or shadow it.
export const SESSION_COOKIE = "__Host-ew_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return `password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters`;
  }
  return null;
}

export interface Device {
  id: string;
  account_id: string;
  name: string;
}

export async function createSession(c: Context<App>, userId: string): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await c.env.DB.prepare(
    `INSERT INTO sessions (id_hash, user_id, expires_at, created_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(await sha256(token), userId, expiresAt, now, now, c.req.header("user-agent")?.slice(0, 300) ?? null)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function destroySession(c: Context<App>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}

/** The signed-in user and their session id (hash), refreshing last_seen_at occasionally. */
export async function sessionUser(c: Context<App>): Promise<{ user: User; sessionId: string } | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const sessionId = await sha256(token);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.totp_secret IS NOT NULL AS totp, s.last_seen_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.expires_at > ?`,
  )
    .bind(sessionId, now)
    .first<{ id: string; username: string; totp: number; last_seen_at: number | null }>();
  if (!row) return null;
  if (!row.last_seen_at || now - row.last_seen_at > TOUCH_INTERVAL_MS) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(now, sessionId).run(),
    );
  }
  return { user: { id: row.id, username: row.username, totpEnabled: row.totp === 1 }, sessionId };
}

// Verifying against a dummy hash for unknown users keeps response time from
// revealing which usernames exist.
let dummyHash: Promise<string> | undefined;

export async function checkPassword(storedHash: string | undefined, password: string): Promise<boolean> {
  if (!storedHash) {
    dummyHash ??= hashPassword("not-a-real-password");
    await verifyPassword(password, await dummyHash);
    return false;
  }
  return verifyPassword(password, storedHash);
}

/** Resolves a daemon's `Authorization: Bearer <credential>` to its device. */
export async function bearerDevice(c: Context<App>): Promise<Device | null> {
  const header = c.req.header("authorization") ?? "";
  const credential = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!credential) return null;
  return c.env.DB.prepare(
    "SELECT id, account_id, name FROM devices WHERE credential_hash = ? AND revoked_at IS NULL",
  )
    .bind(await sha256(credential))
    .first<Device>();
}
