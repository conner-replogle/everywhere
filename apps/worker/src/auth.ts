import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomToken, sha256 } from "./crypto";
import type { App, User } from "./types";

export const SESSION_COOKIE = "ew_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface Device {
  id: string;
  account_id: string;
  name: string;
}

export async function createSession(c: Context<App>, userId: string): Promise<void> {
  const token = randomToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await c.env.DB.prepare("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, expiresAt)
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
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function sessionUser(c: Context<App>): Promise<User | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return c.env.DB.prepare(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256(token), Date.now())
    .first<User>();
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
