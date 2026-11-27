const PBKDF2_ITERATIONS = 100_000; // Workers' WebCrypto maximum
const ENCODER = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Short, URL-safe id for rows and connections. */
export function randomId(): string {
  return randomToken(9);
}

export async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(input));
  return b64url(new Uint8Array(digest));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ENCODER.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  const actual = await pbkdf2(password, fromB64url(salt), Number(iter));
  const expected = fromB64url(hash);
  return actual.length === expected.length && crypto.subtle.timingSafeEqual(actual, expected);
}
