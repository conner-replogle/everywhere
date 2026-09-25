import { b64url, fromB64url } from "./crypto";

// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption
// (RFC 8291), on WebCrypto alone.
//
// The VAPID_KEY secret is the application server's P-256 private key as a JWK;
// `bun run vapid-key` makes one. Browsers get the public half from
// GET /api/push/key when they subscribe.

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushOptions {
  /** Seconds the push service keeps an undelivered message. */
  ttl: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /** A newer message with the same topic replaces an undelivered one (≤ 32 base64url chars). */
  topic?: string;
}

/** Where browsers' push services live; subscriptions elsewhere are refused (no SSRF). */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

export function validPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

interface Vapid {
  privateKey: CryptoKey;
  /** Uncompressed point, base64url: the browser's applicationServerKey. */
  publicKey: string;
}

let cached: { jwk: string; vapid: Promise<Vapid> } | undefined;

function vapid(env: Env): Promise<Vapid> {
  if (!env.VAPID_KEY) throw new Error("VAPID_KEY secret is not configured");
  if (cached?.jwk !== env.VAPID_KEY) {
    const jwk = JSON.parse(env.VAPID_KEY) as JsonWebKey;
    cached = {
      jwk: env.VAPID_KEY,
      vapid: (async () => ({
        privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
        publicKey: b64url(concat(new Uint8Array([4]), fromB64url(jwk.x ?? ""), fromB64url(jwk.y ?? ""))),
      }))(),
    };
  }
  return cached.vapid;
}

export async function vapidPublicKey(env: Env): Promise<string> {
  return (await vapid(env)).publicKey;
}

/**
 * Sends one push. Resolves to the push service's status: 201 when accepted;
 * 404 and 410 mean the subscription is gone for good.
 */
export async function sendPush(env: Env, sub: PushSubscription, payload: unknown, opts: PushOptions): Promise<number> {
  const { privateKey, publicKey } = await vapid(env);
  const body = await encrypt(sub, new TextEncoder().encode(JSON.stringify(payload)));
  const jwt = await vapidJwt(privateKey, new URL(sub.endpoint).origin, env.PUBLIC_URL);
  const headers: Record<string, string> = {
    authorization: `vapid t=${jwt}, k=${publicKey}`,
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(opts.ttl),
  };
  if (opts.urgency) headers.urgency = opts.urgency;
  if (opts.topic) headers.topic = opts.topic;
  const res = await fetch(sub.endpoint, { method: "POST", headers, body });
  return res.status;
}

async function vapidJwt(key: CryptoKey, audience: string, subject: string): Promise<string> {
  const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: audience, exp, sub: subject })}`;
  // WebCrypto's ECDSA signature is r || s, which is what ES256 wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

/**
 * RFC 8291: one aes128gcm record, keyed from ECDH with the browser's key and
 * its auth secret. `fixed` pins the random parts, for the RFC's test vector.
 */
export async function encrypt(
  sub: PushSubscription,
  plaintext: Uint8Array,
  fixed?: { local: CryptoKeyPair; salt: Uint8Array },
): Promise<Uint8Array> {
  const uaPublic = fromB64url(sub.p256dh);
  const authSecret = fromB64url(sub.auth);
  const local =
    fixed?.local ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    // workers-types spells `public` as `$public` (a reserved word); the runtime takes `public`.
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      local.privateKey,
      256,
    ),
  );

  const text = (s: string) => new TextEncoder().encode(s);
  const ikm = await hkdf(authSecret, ecdhSecret, concat(text("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, text("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the last (only) record; no further padding.
  const record = concat(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record));

  // Header: salt (16) | record size (4, big-endian) | key id length (1) | key id (our public key).
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Sends a payload to several subscriptions, forgetting the ones the push
 * service says are gone. Resolves to how many accepted it.
 */
export async function deliver(
  env: Env,
  subs: PushSubscription[],
  payload: unknown,
  opts: PushOptions,
): Promise<number> {
  const results = await Promise.all(
    subs.map(async (sub) => {
      try {
        const status = await sendPush(env, sub, payload, opts);
        if (status === 404 || status === 410) {
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
        } else if (status >= 400) {
          console.warn("push rejected", new URL(sub.endpoint).host, status);
        }
        return status < 300;
      } catch (err) {
        console.warn("push failed", new URL(sub.endpoint).host, err);
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}
