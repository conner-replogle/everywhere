// Push notifications: a claude thread that needs the user, or finished,
// notifies every browser that turned them on (Web Push), unless someone is
// looking at it; open tabs show an in-app alert.

import type { HubNotify } from "@everywhere/protocol";
import { notifyNeedsYou, notifyText } from "@everywhere/protocol";
import { sha256 } from "../crypto";
import { push as routes } from "../routes/push";
import { deliver, type PushOptions } from "../webpush";
import type { HubHost, WorkerPlugin } from "./types";

// Several permission prompts can arrive at once (parallel tool calls); one
// notification per thread and kind in this window is enough.
const NOTIFY_THROTTLE_MS = 5_000;

/** When each thread last caused a notification of each kind. In memory: losing it only risks a repeat. */
const lastNotified = new Map<string, number>();

async function notify(hub: HubHost, deviceId: string, n: HubNotify): Promise<void> {
  const thread = n.parentId || n.threadId;
  if (hub.viewing(deviceId, thread)) return;
  const key = `${deviceId}/${n.threadId}/${n.kind}`;
  const now = Date.now();
  if (now - (lastNotified.get(key) ?? 0) < NOTIFY_THROTTLE_MS) return;
  lastNotified.set(key, now);
  for (const [k, at] of lastNotified) if (now - at > NOTIFY_THROTTLE_MS) lastNotified.delete(k);

  // Open tabs show it in the app too, with a way to switch to the thread.
  hub.broadcast({
    t: "alert",
    deviceId,
    threadId: n.threadId,
    ...(n.parentId ? { parentId: n.parentId } : {}),
    name: n.name,
    kind: n.kind,
    ...(n.tool ? { tool: n.tool } : {}),
  });

  // Someone is using the app, which just showed it; a push would repeat it.
  if (hub.inUse()) return;

  const { results } = await hub.env.DB.prepare(
    `SELECT p.endpoint, p.p256dh, p.auth, d.name AS device
     FROM devices d
     JOIN push_subscriptions p ON p.user_id = d.account_id
     JOIN sessions s ON s.id_hash = p.session_id
     WHERE d.id = ? AND d.revoked_at IS NULL AND s.expires_at > ?`,
  )
    .bind(deviceId, now)
    .all<{ endpoint: string; p256dh: string; auth: string; device: string }>();
  if (results.length === 0) return;

  const needsYou = notifyNeedsYou(n.kind);
  const url = `/d/${encodeURIComponent(deviceId)}/t/${encodeURIComponent(thread)}${
    n.parentId ? `?tab=${encodeURIComponent(n.threadId)}` : ""
  }`;
  const payload = {
    title: n.name.trim() || "Claude",
    body: `${notifyText(n)} · ${results[0]!.device}`,
    // One notification per thread on the device: a newer one replaces it.
    tag: `${deviceId}/${n.threadId}`,
    url,
    renotify: needsYou,
  };
  const opts: PushOptions = {
    ttl: needsYou ? 24 * 60 * 60 : 60 * 60,
    urgency: needsYou ? "high" : "normal",
    topic: (await sha256(payload.tag)).slice(0, 32),
  };
  await deliver(hub.env, results, payload, opts);
}

const NOTIFY_KINDS = new Set<string>(["permission", "question", "plan", "done", "error", "signedOut"]);

function isNotify(m: unknown): m is HubNotify {
  const x = m as Record<string, unknown> | null;
  const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
  return (
    !!x &&
    str(x.threadId, 128) &&
    (x.threadId as string).length > 0 &&
    (x.parentId === undefined || str(x.parentId, 128)) &&
    str(x.name, 200) &&
    (x.tool === undefined || str(x.tool, 100)) &&
    typeof x.kind === "string" &&
    NOTIFY_KINDS.has(x.kind)
  );
}

export const push: WorkerPlugin = {
  id: "push",
  routes: [{ path: "/api/push", app: routes }],
  daemonMessages: {
    notify: async (hub, deviceId, m) => {
      if (isNotify(m)) await notify(hub, deviceId, m);
    },
  },
};
