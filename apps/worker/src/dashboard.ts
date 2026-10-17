import type { Context } from "hono";
import type { App } from "./types";

/**
 * The CSP of a process's dashboard frame (/dashboard): its own scripts and
 * the bundle (a blob), no network, framable by the app only. It names the
 * origin rather than saying 'self': the frame is sandboxed (an opaque
 * origin), and WebKit matches 'self' against that, which refuses every
 * script, so Safari showed a blank page.
 */
export function dashboardCSP(origin: string): string {
  return [
    "default-src 'none'",
    `script-src ${origin} blob:`,
    `style-src ${origin} 'unsafe-inline'`,
    `img-src ${origin} data: blob:`,
    "media-src data: blob:",
    `font-src ${origin} data:`,
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${origin}`,
  ].join("; ");
}

/** Serves dashboard.html with its CSP for the origin it was asked on. */
export async function serveDashboardFrame(c: Context<App>): Promise<Response> {
  const res = await c.env.ASSETS.fetch(new URL("/dashboard", c.req.url));
  const out = new Response(res.body, res);
  out.headers.set("Content-Security-Policy", dashboardCSP(new URL(c.req.url).origin));
  out.headers.delete("X-Frame-Options");
  return out;
}
