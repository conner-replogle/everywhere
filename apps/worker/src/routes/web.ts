import { Hono } from "hono";
import { rateLimited, tooMany } from "../security";
import type { App } from "../types";
import { requireUser } from "./auth";

// Whether a site lets this app show it in an iframe (a web tab). Many don't
// (GitHub, Google), and the browser then shows only an error; the app opens
// those in a new browser tab instead. Only public sites can be checked from
// here: anything the Worker can't reach is taken to allow it.

const TIMEOUT_MS = 3_000;

/**
 * Whether a page with these headers may be framed by a page on appOrigin.
 * CSP frame-ancestors decides when present (browsers then ignore
 * X-Frame-Options); otherwise any X-Frame-Options refuses, since its only
 * allowance is the site's own origin.
 */
export function frameable(headers: Headers, appOrigin: string): boolean {
  const app = new URL(appOrigin);
  let decided = false;
  for (const policy of (headers.get("content-security-policy") ?? "").split(",")) {
    const directive = policy
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .find(([name]) => name?.toLowerCase() === "frame-ancestors");
    if (!directive) continue;
    decided = true;
    // Every policy that names frame-ancestors has to allow it.
    if (!directive.slice(1).some((s) => sourceMatches(s.toLowerCase(), app))) return false;
  }
  return decided || !headers.get("x-frame-options");
}

function sourceMatches(source: string, app: URL): boolean {
  if (source === "*" || source === `${app.protocol}`) return true;
  if (source.startsWith("'")) return false; // 'none', 'self': not this app
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?/.exec(source);
  if (!m) return false;
  const [, scheme, wildcard, host, port] = m;
  if (scheme && `${scheme}:` !== app.protocol) return false;
  if (port && port !== "*" && port !== (app.port || (app.protocol === "https:" ? "443" : "80"))) return false;
  return wildcard ? app.hostname.endsWith(`.${host}`) : app.hostname === host;
}

export const web = new Hono<App>();

web.use("*", requireUser);

web.get("/frameable", async (c) => {
  if (await rateLimited(c, `frameable:${c.var.user.id}`)) return tooMany(c);
  let url: URL;
  try {
    url = new URL(c.req.query("url") ?? "");
  } catch {
    return c.json({ error: "url is required" }, 400);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return c.json({ error: "only web pages" }, 400);
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel();
    return c.json({ frameable: frameable(res.headers, c.env.PUBLIC_URL) });
  } catch {
    // Unreachable from here (a dev server, a private network): let the frame try.
    return c.json({ frameable: true });
  }
});
