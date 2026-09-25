import { Hono } from "hono";
import { fromB64url, randomId } from "../crypto";
import { rateLimited, tooMany } from "../security";
import type { App } from "../types";
import { deliver, validPushEndpoint, vapidPublicKey } from "../webpush";
import { requireUser } from "./auth";

// Web Push subscriptions: a browser turns notifications on by subscribing with
// our VAPID key and registering the subscription here. The AccountHub sends
// to them when a claude thread needs the user (see hub.ts).

export const push = new Hono<App>();

push.use("*", requireUser);

push.get("/key", async (c) => c.json({ publicKey: await vapidPublicKey(c.env) }));

push.post("/subscriptions", async (c) => {
  const body = await c.req.json<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }>();
  const { endpoint } = body;
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;
  if (typeof endpoint !== "string" || endpoint.length > 1024 || !validPushEndpoint(endpoint)) {
    return c.json({ error: "unsupported push service" }, 400);
  }
  if (!keyOfLength(p256dh, 65) || !keyOfLength(auth, 16)) return c.json({ error: "invalid subscription keys" }, 400);
  // A browser re-registers after signing in again; the endpoint moves to this session.
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = excluded.user_id, session_id = excluded.session_id,
       p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
  )
    .bind(
      randomId(),
      c.var.user.id,
      c.var.sessionId,
      endpoint,
      p256dh,
      auth,
      c.req.header("user-agent")?.slice(0, 300) ?? null,
      Date.now(),
    )
    .run();
  return c.json({});
});

push.post("/unsubscribe", async (c) => {
  const { endpoint } = await c.req.json<{ endpoint?: unknown }>();
  if (typeof endpoint !== "string") return c.json({ error: "endpoint is required" }, 400);
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
    .bind(endpoint, c.var.user.id)
    .run();
  return c.json({});
});

push.post("/test", async (c) => {
  if (await rateLimited(c, `push-test:${c.var.user.id}`)) return tooMany(c);
  const { endpoint } = await c.req.json<{ endpoint?: unknown }>();
  const sub = await c.env.DB.prepare(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = ? AND user_id = ?",
  )
    .bind(typeof endpoint === "string" ? endpoint : "", c.var.user.id)
    .first<{ endpoint: string; p256dh: string; auth: string }>();
  if (!sub) return c.json({ error: "this browser isn't subscribed" }, 404);
  const sent = await deliver(
    c.env,
    [sub],
    { title: "everywhere", body: "Notifications work on this device.", tag: "test", url: "/settings/notifications" },
    { ttl: 60, urgency: "high" },
  );
  if (!sent) return c.json({ error: "the push service refused the notification" }, 502);
  return c.json({});
});

function keyOfLength(v: unknown, bytes: number): v is string {
  if (typeof v !== "string" || v.length > 128) return false;
  try {
    return fromB64url(v).length === bytes;
  } catch {
    return false;
  }
}
