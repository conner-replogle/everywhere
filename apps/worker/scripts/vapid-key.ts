#!/usr/bin/env bun
// Makes the VAPID key that signs Web Push requests: a P-256 private key as a
// JWK, for the VAPID_KEY secret.
//
//   bun run vapid-key | bunx wrangler secret put VAPID_KEY
//
// Changing it later invalidates every browser's subscription; each has to
// turn notifications on again.
const { privateKey } = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const { kty, crv, x, y, d } = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
console.log(JSON.stringify({ kty, crv, x, y, d }));
