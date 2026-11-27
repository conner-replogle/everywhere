// Short-lived ICE servers for browsers: Cloudflare STUN plus Realtime TURN
// as a relay fallback. ICE prefers direct (host/srflx/prflx) pairs, so TURN is
// only used when no direct path works. Relayed traffic stays DTLS-encrypted.

const STUN_ONLY: RTCIceServerJson[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
export const TURN_TTL_SECONDS = 12 * 60 * 60;
// Reuse cached TURN credentials in isolate memory while at least 6 hours remain.
const TURN_CACHE_MIN_REMAINING_MS = 6 * 60 * 60 * 1000;

interface RTCIceServerJson {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceServersResult {
  iceServers: RTCIceServerJson[];
  turn: boolean;
  expiresAt: number;
}

let cachedTurn: { key: string; result: IceServersResult } | undefined;
let inflightTurn: { key: string; promise: Promise<IceServersResult> } | undefined;

export async function iceServers(env: Env): Promise<IceServersResult> {
  const fallbackExpiry = () => Date.now() + TURN_TTL_SECONDS * 1000;
  if (!env.TURN_API_TOKEN || !env.TURN_KEY_ID) {
    return { iceServers: STUN_ONLY, turn: false, expiresAt: fallbackExpiry() };
  }
  const cacheKey = `${env.TURN_KEY_ID}:${env.TURN_API_TOKEN}`;
  const now = Date.now();
  if (cachedTurn?.key === cacheKey && cachedTurn.result.expiresAt - now > TURN_CACHE_MIN_REMAINING_MS) {
    return cachedTurn.result;
  }
  if (inflightTurn?.key === cacheKey) {
    return inflightTurn.promise;
  }
  const promise = (async (): Promise<IceServersResult> => {
    const requestedAt = Date.now();
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.TURN_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
      },
    );
    if (!res.ok) {
      console.error("TURN credential request failed", res.status, await res.text());
      return { iceServers: STUN_ONLY, turn: false, expiresAt: fallbackExpiry() };
    }
    const data = await res.json<{ iceServers: RTCIceServerJson[] | RTCIceServerJson }>();
    const servers = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    // Browsers refuse port 53; drop those URLs.
    const cleaned = servers
      .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length > 0);
    const result: IceServersResult = {
      iceServers: cleaned,
      turn: true,
      expiresAt: requestedAt + TURN_TTL_SECONDS * 1000,
    };
    cachedTurn = { key: cacheKey, result };
    return result;
  })().finally(() => {
    if (inflightTurn?.promise === promise) inflightTurn = undefined;
  });
  inflightTurn = { key: cacheKey, promise };
  return promise;
}
