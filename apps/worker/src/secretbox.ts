import { b64url, fromB64url } from "./crypto";

// AES-256-GCM for small secrets at rest (TOTP seeds). Format: v1.<iv>.<ciphertext>.

async function key(env: Env): Promise<CryptoKey> {
  if (!env.TOTP_KEY) throw new Error("TOTP_KEY secret is not configured");
  const raw = Uint8Array.from(atob(env.TOTP_KEY), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("TOTP_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(env: Env, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), new TextEncoder().encode(plaintext));
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function open(env: Env, sealed: string): Promise<string> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("unrecognized sealed value");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv) }, await key(env), fromB64url(ct));
  return new TextDecoder().decode(pt);
}
