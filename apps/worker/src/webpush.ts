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

const ENCODER = new TextEncoder();
const VAPID_JWT_TTL_S = 12 * 60 * 60;
const VAPID_JWT_REUSE_S = 6 * 60 * 60;
const INFO_WEBPUSH = ENCODER.encode("WebPush: info\0");
const INFO_AES128GCM = ENCODER.encode("Content-Encoding: aes128gcm\0");
const INFO_NONCE = ENCODER.encode("Content-Encoding: nonce\0");
const JWT_HEADER_B64 = b64url(ENCODER.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));

const cachedJwts = new Map<string, { jwt: string; exp: number }>();

/**
 * Sends one push. Resolves to the push service's status: 201 when accepted;
 * 404 and 410 mean the subscription is gone for good.
 */
export async function sendPush(env: Env, sub: PushSubscription, payload: unknown, opts: PushOptions): Promise<number> {
  return sendPushBytes(env, sub, ENCODER.encode(JSON.stringify(payload)), opts);
}

async function sendPushBytes(env: Env, sub: PushSubscription, plaintext: Uint8Array, opts: PushOptions): Promise<number> {
  const { privateKey, publicKey } = await vapid(env);
  const origin = new URL(sub.endpoint).origin;
  const [body, jwt] = await Promise.all([
    encrypt(sub, plaintext),
    vapidJwt(privateKey, origin, env.PUBLIC_URL, env.VAPID_KEY),
  ]);
  const headers: Record<string, string> = {
    authorization: `vapid t=${jwt}, k=${publicKey}`,
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(opts.ttl),
  };
  if (opts.urgency) headers.urgency = opts.urgency;
  if (opts.topic) headers.topic = opts.topic;
  const res = await fetch(sub.endpoint, { method: "POST", headers, body });
  await res.body?.cancel();
  return res.status;
}

async function vapidJwt(key: CryptoKey, audience: string, subject: string, keyId: string): Promise<string> {
  const nowS = Math.floor(Date.now() / 1000);
  const cacheKey = `${audience}\0${subject}\0${keyId}`;
  const hit = cachedJwts.get(cacheKey);
  if (hit && hit.exp - nowS > VAPID_JWT_REUSE_S) return hit.jwt;

  const exp = nowS + VAPID_JWT_TTL_S;
  const claims = b64url(ENCODER.encode(JSON.stringify({ aud: audience, exp, sub: subject })));
  const unsigned = `${JWT_HEADER_B64}.${claims}`;
  // WebCrypto's ECDSA signature is r || s, which is what ES256 wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, ENCODER.encode(unsigned));
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;
  if (cachedJwts.size > 32) cachedJwts.clear();
  cachedJwts.set(cacheKey, { jwt, exp });
  return jwt;
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
  const [local, uaKey] = await Promise.all([
    fixed?.local
      ? Promise.resolve(fixed.local)
      : (crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as Promise<CryptoKeyPair>),
    crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []),
  ]);
  const [asPublicBuf, ecdhSecretBuf] = await Promise.all([
    crypto.subtle.exportKey("raw", local.publicKey),
    // workers-types spells `public` as `$public` (a reserved word); the runtime takes `public`.
    crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      local.privateKey,
      256,
    ),
  ]);
  const asPublic = new Uint8Array(asPublicBuf as ArrayBuffer);
  const ecdhSecret = new Uint8Array(ecdhSecretBuf);

  const ikm = await hkdf(authSecret, ecdhSecret, concat(INFO_WEBPUSH, uaPublic, asPublic), 32);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const [cekBuf, nonceBuf] = await Promise.all([
    crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: INFO_AES128GCM }, ikmKey, 16 * 8),
    crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: INFO_NONCE }, ikmKey, 12 * 8),
  ]);
  const cek = new Uint8Array(cekBuf);
  const nonce = new Uint8Array(nonceBuf);

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
  if (subs.length === 0) return 0;
  const plaintext = ENCODER.encode(JSON.stringify(payload));
  const dead: string[] = [];
  const results = await Promise.all(
    subs.map(async (sub) => {
      try {
        const status = await sendPushBytes(env, sub, plaintext, opts);
        if (status === 404 || status === 410) {
          dead.push(sub.endpoint);
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
  if (dead.length > 0) {
    await env.DB.batch(
      dead.map((ep) => env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(ep)),
    );
  }
  return results.filter(Boolean).length;
}
