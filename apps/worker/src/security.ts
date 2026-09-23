import type { Context, Next } from "hono";
import type { App } from "./types";

/**
 * Origins allowed to make state-changing and WebSocket requests: our public
 * origin, the origin the request was addressed to (a browser only sends that
 * as Origin from our own pages; this also covers wrangler dev, which rewrites
 * both), and any extra dev origins.
 */
function allowedOrigins(c: Context<App>): Set<string> {
  const origins = new Set([new URL(c.env.PUBLIC_URL).origin, new URL(c.req.url).origin]);
  for (const o of c.env.ALLOWED_ORIGINS.split(",")) if (o.trim()) origins.add(o.trim());
  return origins;
}

export function originAllowed(c: Context<App>): boolean {
  const origin = c.req.header("origin");
  return !!origin && allowedOrigins(c).has(origin);
}

/**
 * Headers for Worker-generated responses (static assets get theirs from
 * apps/web/public/_headers), plus CSRF defense for the API:
 * - state-changing requests must be JSON (HTML forms can't send it cross-site),
 * - and, when the browser sends an Origin, it must be ours.
 * Daemons don't send Origin and authenticate with a bearer credential.
 */
export async function apiGuard(c: Context<App>, next: Next) {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const origin = c.req.header("origin");
    if (origin && !allowedOrigins(c).has(origin)) {
      return c.json({ error: "cross-origin request rejected" }, 403);
    }
    if (!(c.req.header("content-type") ?? "").startsWith("application/json")) {
      return c.json({ error: "content-type must be application/json" }, 415);
    }
  }
  await next();
  if (c.res.status === 101) return; // WebSocket upgrade; headers are immutable
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("x-frame-options", "DENY");
}

export function clientIp(c: Context<App>): string {
  return c.req.header("cf-connecting-ip") ?? "local";
}

/** True if any of the keys is over its limit. Every key is counted. */
export async function rateLimited(c: Context<App>, ...keys: string[]): Promise<boolean> {
  const results = await Promise.all(keys.map((key) => c.env.AUTH_LIMITER.limit({ key })));
  return results.some((r) => !r.success);
}

export function tooMany(c: Context<App>) {
  return c.json({ error: "too many attempts; wait a minute and try again" }, 429);
}
