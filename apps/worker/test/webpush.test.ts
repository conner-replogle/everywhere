// RFC 8291 Appendix A: the example message, byte for byte.
import { expect, test } from "bun:test";
import { b64url, fromB64url } from "../src/crypto";
import { encrypt } from "../src/webpush";

test("encrypt matches RFC 8291's example", async () => {
  const asPublic = fromB64url("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64url(asPublic.slice(1, 33)),
    y: b64url(asPublic.slice(33)),
    d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  };
  const alg = { name: "ECDH", namedCurve: "P-256" };
  const local = {
    privateKey: await crypto.subtle.importKey("jwk", jwk, alg, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", asPublic, alg, true, []),
  };
  const body = await encrypt(
    {
      endpoint: "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV",
      p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    },
    new TextEncoder().encode("When I grow up, I want to be a watermelon"),
    { local, salt: fromB64url("DGv6ra1nlYgDCS1FRnbzlw") },
  );
  expect(b64url(body)).toBe(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});
