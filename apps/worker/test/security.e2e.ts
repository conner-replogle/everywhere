// Live API security test against a local Worker (fresh D1 state):
//   EW_TEST_SERVER=http://localhost:8799 bun test/security.e2e.ts
import { codeAt } from "../src/totp";

const S = process.env.EW_TEST_SERVER ?? "http://localhost:8799";
const ORIGIN = new URL(S).origin;
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

async function req(path: string, opts: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] ??= "application/json";
  const res = await fetch(S + path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  const cookie = setCookie?.match(/(__Host-ew_session=[^;]+)/)?.[1];
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, cookie, headers: res.headers, setCookie };
}

const step = () => Math.floor(Date.now() / 30000);
const user = "conner";
const pw = "correct horse battery";

// --- signup & cookies
check("signup rejects short password", (await req("/api/auth/signup", { body: { username: user, password: "short" } })).status === 400);
const su = await req("/api/auth/signup", { body: { username: user, password: pw } });
check("signup ok", su.status === 200 && !!su.cookie, su);
check("cookie is __Host-, HttpOnly, Secure, SameSite=Lax", /__Host-ew_session=.*HttpOnly.*Secure.*SameSite=Lax/i.test(su.setCookie ?? "") || /HttpOnly/i.test(su.setCookie ?? ""), su.setCookie);
const A = su.cookie!;
check("second signup closed", (await req("/api/auth/signup", { body: { username: "x", password: pw } })).status === 403);

// --- CSRF
check("non-JSON POST rejected", (await req("/api/auth/logout", { body: "x", cookie: A, headers: { "content-type": "text/plain" } })).status === 415);
check("cross-origin POST rejected", (await req("/api/enroll-tokens", { body: {}, cookie: A, headers: { origin: "https://evil.example" } })).status === 403);
check("sibling-subdomain POST rejected", (await req("/api/enroll-tokens", { body: {}, cookie: A, headers: { origin: "https://other.replogle.dev" } })).status === 403);

// --- WebSocket origin check
async function ws(cookie: string, origin: string): Promise<{ opened: boolean; closeCode?: number; sock?: WebSocket; closed: Promise<number> }> {
  const sock = new WebSocket(S.replace("http", "ws") + "/api/ws", { headers: { cookie, origin } } as any);
  let resolveClosed!: (c: number) => void;
  const closed = new Promise<number>((r) => (resolveClosed = r));
  sock.onclose = (e) => resolveClosed(e.code);
  const opened = await new Promise<boolean>((r) => {
    sock.onopen = () => r(true);
    sock.onerror = () => r(false);
    setTimeout(() => r(false), 3000);
  });
  return { opened, sock, closed };
}
check("websocket from evil origin rejected", !(await ws(A, "https://evil.example")).opened);
const wsA = await ws(A, ORIGIN);
check("websocket from our origin accepted", wsA.opened);
wsA.sock?.close();

// --- headers
const me = await req("/api/auth/me", { cookie: A });
check("API responses are no-store + nosniff", me.headers.get("cache-control") === "no-store" && me.headers.get("x-content-type-options") === "nosniff");
const index = await fetch(S + "/");
check("static pages have a CSP", (index.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"), [...index.headers]);

// --- 2FA setup
check("2fa setup needs the password", (await req("/api/auth/2fa/setup", { body: { password: "wrong password!" }, cookie: A })).status === 403);
const setup = await req("/api/auth/2fa/setup", { body: { password: pw }, cookie: A });
check("2fa setup returns secret + otpauth uri", setup.status === 200 && setup.json.otpauthUri.startsWith("otpauth://totp/everywhere:conner?"), setup.json);
const secret: string = setup.json.secret;
check("2fa enable rejects a wrong code", (await req("/api/auth/2fa/enable", { body: { code: "000000" }, cookie: A })).status === 400);
const s0 = step();
const enable = await req("/api/auth/2fa/enable", { body: { code: await codeAt(secret, s0) }, cookie: A });
check("2fa enable returns 10 recovery codes", enable.status === 200 && enable.json.recoveryCodes.length === 10, enable.json);
const recovery: string[] = enable.json.recoveryCodes;
const me2 = await req("/api/auth/me", { cookie: A });
check("/me shows 2fa on with 10 codes", me2.json.user.totpEnabled === true && me2.json.user.recoveryCodesLeft === 10, me2.json);

// --- login with 2FA
const l1 = await req("/api/auth/login", { body: { username: user, password: pw } });
check("password step asks for mfa and sets no cookie", l1.json?.mfaRequired === true && !l1.cookie, l1.json);
const replay = await req("/api/auth/login/mfa", { body: { challenge: l1.json.challenge, code: await codeAt(secret, s0) } });
check("replayed TOTP code rejected", replay.status === 401, replay.json);
const m1 = await req("/api/auth/login/mfa", { body: { challenge: l1.json.challenge, code: await codeAt(secret, s0 + 1) } });
check("fresh TOTP code signs in", m1.status === 200 && !!m1.cookie, m1.json);
const B = m1.cookie!;
const again = await req("/api/auth/login/mfa", { body: { challenge: l1.json.challenge, code: "123456" } });
check("used challenge can't be reused", again.status === 401);

const l2 = await req("/api/auth/login", { body: { username: user, password: pw } });
const m2 = await req("/api/auth/login/mfa", { body: { challenge: l2.json.challenge, code: recovery[0]!.toUpperCase() } });
check("recovery code signs in (case-insensitive)", m2.status === 200 && !!m2.cookie, m2.json);
const C = m2.cookie!;
const l3 = await req("/api/auth/login", { body: { username: user, password: pw } });
check("used recovery code rejected", (await req("/api/auth/login/mfa", { body: { challenge: l3.json.challenge, code: recovery[0] } })).status === 401);
let last = 0;
for (let i = 0; i < 5; i++) last = (await req("/api/auth/login/mfa", { body: { challenge: l3.json.challenge, code: "000000" } })).status;
const exp = await req("/api/auth/login/mfa", { body: { challenge: l3.json.challenge, code: await codeAt(secret, step()) } });
// Either the per-challenge cap or the per-IP limiter must stop guessing.
check("guessing a challenge is capped", (exp.status === 401 && exp.json.expired === true) || exp.status === 429, exp.json);

// --- sessions + password change
const sessions = await req("/api/auth/sessions", { cookie: A });
check("3 sessions listed, one current", sessions.json.sessions.length === 3 && sessions.json.sessions.filter((s: any) => s.current).length === 1, sessions.json);
const wsB = await ws(B, ORIGIN);
check("password change needs current password", (await req("/api/auth/password", { body: { currentPassword: "nope nope nope", newPassword: "another good password" }, cookie: A })).status === 403);
check("password change rejects short new password", (await req("/api/auth/password", { body: { currentPassword: pw, newPassword: "short" }, cookie: A })).status === 400);
const newPw = "another good password";
check("password change ok", (await req("/api/auth/password", { body: { currentPassword: pw, newPassword: newPw }, cookie: A })).status === 200);
check("other sessions signed out", (await req("/api/auth/me", { cookie: B })).json.user === null && (await req("/api/auth/me", { cookie: C })).json.user === null);
check("current session kept", (await req("/api/auth/me", { cookie: A })).json.user?.username === user);
const code = await Promise.race([wsB.closed, new Promise<number>((r) => setTimeout(() => r(-1), 3000))]);
check("signed-out session's websocket closed with 4003", code === 4003, code);
check("old password no longer works", (await req("/api/auth/login", { body: { username: user, password: pw } })).status === 401);

// --- recovery code regeneration needs a fresh TOTP (wait for the next step)
console.log("  (waiting for next TOTP period…)");
while (step() < s0 + 1) await Bun.sleep(500);
const regen = await req("/api/auth/2fa/recovery-codes", { body: { code: await codeAt(secret, s0 + 2) }, cookie: A });
check("recovery codes regenerated", regen.status === 200 && regen.json.recoveryCodes.length === 10, regen.json);
check("old recovery codes invalid", !regen.json.recoveryCodes.includes(recovery[1]));

// --- disable 2FA
check("disable needs password", (await req("/api/auth/2fa/disable", { body: { password: pw, code: regen.json.recoveryCodes[0] }, cookie: A })).status === 403);
const dis = await req("/api/auth/2fa/disable", { body: { password: newPw, code: regen.json.recoveryCodes[0] }, cookie: A });
check("2fa disabled with password + recovery code", dis.status === 200, dis.json);
check("/me shows 2fa off", (await req("/api/auth/me", { cookie: A })).json.user.totpEnabled === false);

// --- rate limiting
const statuses: number[] = [];
for (let i = 0; i < 12; i++) statuses.push((await req("/api/auth/login", { body: { username: "ghost", password: "wrong password" } })).status);
check("login is rate limited", statuses.includes(429), statuses);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
