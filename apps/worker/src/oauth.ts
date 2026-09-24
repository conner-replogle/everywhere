// OAuth 2.1 authorization server for the MCP endpoint, so agents such as a
// ChatGPT connector can act on the account: metadata discovery (RFC 8414,
// RFC 9728), dynamic client registration (RFC 7591), the authorization code
// flow with PKCE (S256 only) behind a consent page, and rotating refresh
// tokens. Clients are anyone who registers; only the user's approval on the
// consent page (behind their normal sign-in) grants access.
import { Hono } from "hono";
import type { Context } from "hono";
import { sessionUser } from "./auth";
import { b64url, randomId, randomToken, sha256 } from "./crypto";
import { clientIp, rateLimited } from "./security";
import type { App } from "./types";

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Registered clients nobody approved are dropped after this long. */
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const SCOPE = "everywhere";

export const oauth = new Hono<App>();

// Clients call these from browsers too (e.g. the MCP Inspector). Nothing here
// uses cookies except the consent page, which isn't CORS-enabled.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
};

function cors(c: Context<App>) {
  for (const [k, v] of Object.entries(CORS)) c.header(k, v);
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
}

export function mcpResource(env: Env): string {
  return `${env.PUBLIC_URL}/mcp`;
}

export function resourceMetadataUrl(env: Env): string {
  return `${env.PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`;
}

// --- discovery --------------------------------------------------------------

function serverMetadata(env: Env) {
  const base = env.PUBLIC_URL;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [SCOPE],
  };
}

for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
  oauth.options(path, (c) => (cors(c), c.body(null, 204)));
  oauth.get(path, (c) => (cors(c), c.json(serverMetadata(c.env))));
}

for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
  oauth.options(path, (c) => (cors(c), c.body(null, 204)));
  oauth.get(path, (c) => {
    cors(c);
    return c.json({
      resource: mcpResource(c.env),
      authorization_servers: [c.env.PUBLIC_URL],
      bearer_methods_supported: ["header"],
      scopes_supported: [SCOPE],
      resource_name: "everywhere",
    });
  });
}

// --- registration -------------------------------------------------------------

interface ClientRow {
  id: string;
  name: string;
  redirect_uris: string;
  secret_hash: string | null;
}

/** https anywhere, or http on loopback (local tools); no fragments. */
function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== "string" || uri.length > 2000) return "invalid redirect_uri";
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return `invalid redirect_uri: ${uri}`;
  }
  if (u.hash) return "redirect_uri must not have a fragment";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    return "redirect_uri must be https (or http on localhost)";
  }
  return null;
}

oauth.options("/oauth/register", (c) => (cors(c), c.body(null, 204)));
oauth.post("/oauth/register", async (c) => {
  cors(c);
  if (await rateLimited(c, `oauth-register:${clientIp(c)}`)) {
    return c.json({ error: "slow_down", error_description: "too many registrations; wait a minute" }, 429);
  }
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_client_metadata", error_description: "body must be JSON" }, 400);
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
    return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris is required" }, 400);
  }
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) return c.json({ error: "invalid_redirect_uri", error_description: problem }, 400);
  }
  const authMethod = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
  if (!["none", "client_secret_post", "client_secret_basic"].includes(authMethod)) {
    return c.json({ error: "invalid_client_metadata", error_description: `unsupported token_endpoint_auth_method ${authMethod}` }, 400);
  }
  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code", "refresh_token"];
  if (grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    return c.json({ error: "invalid_client_metadata", error_description: "unsupported grant_types" }, 400);
  }
  const name = (typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim() : "Unnamed app").slice(0, 100);

  const now = Date.now();
  const id = `ewc_${randomId()}`;
  const secret = authMethod === "none" ? null : `ews_${randomToken()}`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM oauth_grants)",
    ).bind(now - UNUSED_CLIENT_TTL_MS),
    c.env.DB.prepare(
      "INSERT INTO oauth_clients (id, name, redirect_uris, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(id, name, JSON.stringify(uris), secret ? await sha256(secret) : null, now),
  ]);
  return c.json(
    {
      client_id: id,
      client_id_issued_at: Math.floor(now / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: authMethod,
      scope: SCOPE,
    },
    201,
  );
});

async function getClient(env: Env, id: string | undefined): Promise<ClientRow | null> {
  if (!id) return null;
  return env.DB.prepare("SELECT id, name, redirect_uris, secret_hash FROM oauth_clients WHERE id = ?")
    .bind(id)
    .first<ClientRow>();
}

// --- authorization --------------------------------------------------------------

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string;
  scope: string;
}

type Checked = { ok: true; client: ClientRow; params: AuthorizeParams } | { ok: false; response: Response };

/**
 * Validates an authorization request. Problems with the client or its
 * redirect URI get an error page (redirecting could send an attacker the
 * error); the rest go back to the client.
 */
async function checkAuthorize(c: Context<App>, q: Record<string, string | undefined>): Promise<Checked> {
  const client = await getClient(c.env, q.client_id);
  if (!client) return { ok: false, response: page(c, "Unknown app", "This app isn't registered here. Try connecting it again.", 400) };
  const uris = JSON.parse(client.redirect_uris) as string[];
  const redirectUri = q.redirect_uri ?? (uris.length === 1 ? uris[0] : undefined);
  if (!redirectUri || !uris.includes(redirectUri)) {
    return { ok: false, response: page(c, "Invalid request", "The app's redirect address doesn't match what it registered.", 400) };
  }
  const fail = (error: string, description: string) => ({
    ok: false as const,
    response: c.redirect(withParams(redirectUri, { error, error_description: description, state: q.state }), 302),
  });
  if (q.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
  if (!q.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) {
    return fail("invalid_request", "a PKCE code_challenge is required");
  }
  if ((q.code_challenge_method ?? "plain") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  if (q.resource && !sameResource(q.resource, mcpResource(c.env))) {
    return fail("invalid_target", `unknown resource; use ${mcpResource(c.env)}`);
  }
  return {
    ok: true,
    client,
    params: {
      client_id: client.id,
      redirect_uri: redirectUri,
      code_challenge: q.code_challenge,
      state: q.state ?? "",
      scope: SCOPE,
    },
  };
}

function sameResource(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\/+$/, "");
  return norm(a) === norm(b);
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

/** Binds the consent form to the signed-in session, so other sites can't submit it. */
async function consentToken(sessionId: string): Promise<string> {
  return sha256(`oauth-consent:${sessionId}`);
}

oauth.get("/oauth/authorize", async (c) => {
  const s = await sessionUser(c);
  if (!s) {
    const back = new URL(c.req.url);
    return c.redirect(`/login?redirect=${encodeURIComponent(back.pathname + back.search)}`, 302);
  }
  const checked = await checkAuthorize(c, c.req.query());
  if (!checked.ok) return checked.response;
  const { client, params } = checked;
  const token = await consentToken(s.sessionId);
  const host = new URL(params.redirect_uri).host;
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
    .join("");
  return page(
    c,
    `Connect ${client.name}?`,
    `<p><strong>${esc(client.name)}</strong> wants to act as <strong>${esc(s.user.username)}</strong> on everywhere.
     It will be able to:</p>
     <ul>
       <li>see your devices, projects and threads, and read their history</li>
       <li>create projects and threads, and send messages to them</li>
       <li>answer permission prompts and type into terminals on your devices</li>
     </ul>
     <p class="muted">You'll be sent back to <strong>${esc(host)}</strong>. Only continue if you started this.
     You can disconnect it any time under Settings → Security.</p>
     <form method="post" action="/oauth/authorize">
       ${hidden}<input type="hidden" name="csrf" value="${token}">
       <div class="actions">
         <button name="decision" value="deny" class="secondary">Cancel</button>
         <button name="decision" value="allow" autofocus>Allow</button>
       </div>
     </form>`,
    200,
    params.redirect_uri,
  );
});

oauth.post("/oauth/authorize", async (c) => {
  const s = await sessionUser(c);
  if (!s) return page(c, "Signed out", "Your session ended. Start connecting the app again.", 401);
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.env.PUBLIC_URL).origin && origin !== new URL(c.req.url).origin) {
    return page(c, "Invalid request", "This form was submitted from another site.", 403);
  }
  const form = await c.req.parseBody();
  const q = Object.fromEntries(
    Object.entries(form).map(([k, v]) => [k, typeof v === "string" ? v : undefined]),
  ) as Record<string, string | undefined>;
  if (q.csrf !== (await consentToken(s.sessionId))) {
    return page(c, "Invalid request", "This form expired. Start connecting the app again.", 403);
  }
  const checked = await checkAuthorize(c, { ...q, response_type: "code", code_challenge_method: "S256" });
  if (!checked.ok) return checked.response;
  const { params } = checked;
  if (q.decision !== "allow") {
    return c.redirect(
      withParams(params.redirect_uri, { error: "access_denied", error_description: "the user declined", state: params.state }),
      302,
    );
  }
  const grantId = randomId();
  const code = randomToken();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO oauth_grants (id, user_id, client_id, created_at) VALUES (?, ?, ?, ?)").bind(
      grantId,
      s.user.id,
      params.client_id,
      now,
    ),
    c.env.DB.prepare(
      "INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(await sha256(code), grantId, params.redirect_uri, params.code_challenge, now + CODE_TTL_MS),
  ]);
  return c.redirect(
    withParams(params.redirect_uri, { code, state: params.state, iss: c.env.PUBLIC_URL }),
    302,
  );
});

// --- tokens ---------------------------------------------------------------------

function tokenError(c: Context<App>, error: string, description: string, status: 400 | 401 | 429 = 400) {
  return c.json({ error, error_description: description }, status);
}

/** The client authenticating at the token endpoint (secret, or none for public clients). */
async function authenticateClient(
  c: Context<App>,
  form: Record<string, string | undefined>,
): Promise<ClientRow | null> {
  let id = form.client_id;
  let secret = form.client_secret;
  const basic = c.req.header("authorization");
  if (basic?.startsWith("Basic ")) {
    try {
      const [u, p] = atob(basic.slice(6)).split(":");
      id = decodeURIComponent(u ?? "");
      secret = decodeURIComponent(p ?? "");
    } catch {
      return null;
    }
  }
  const client = await getClient(c.env, id);
  if (!client) return null;
  if (client.secret_hash) {
    if (!secret || (await sha256(secret)) !== client.secret_hash) return null;
  }
  return client;
}

async function issueTokens(c: Context<App>, grantId: string) {
  const now = Date.now();
  const access = `ewa_${randomToken()}`;
  const refresh = `ewr_${randomToken()}`;
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_tokens WHERE grant_id = ? AND expires_at < ?").bind(grantId, now),
    c.env.DB.prepare("INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES (?, ?, 'access', ?)").bind(
      await sha256(access),
      grantId,
      now + ACCESS_TTL_MS,
    ),
    c.env.DB.prepare("INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES (?, ?, 'refresh', ?)").bind(
      await sha256(refresh),
      grantId,
      now + REFRESH_TTL_MS,
    ),
    c.env.DB.prepare("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").bind(now, grantId),
  ]);
  return c.json({
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refresh,
    scope: SCOPE,
  });
}

async function formBody(c: Context<App>): Promise<Record<string, string | undefined>> {
  const type = c.req.header("content-type") ?? "";
  if (type.startsWith("application/json")) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
  }
  const form = await c.req.parseBody();
  return Object.fromEntries(Object.entries(form).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
}

oauth.options("/oauth/token", (c) => (cors(c), c.body(null, 204)));
oauth.post("/oauth/token", async (c) => {
  cors(c);
  const form = await formBody(c);
  const client = await authenticateClient(c, form);
  if (!client) return tokenError(c, "invalid_client", "unknown client or wrong secret", 401);
  if (await rateLimited(c, `oauth-token:${client.id}`)) return tokenError(c, "slow_down", "too many requests", 429);
  const now = Date.now();

  if (form.grant_type === "authorization_code") {
    if (!form.code || !form.code_verifier) return tokenError(c, "invalid_request", "code and code_verifier are required");
    // Consume the code first, so it can only ever be exchanged once.
    const row = await c.env.DB.prepare(
      `DELETE FROM oauth_codes WHERE code_hash = ? AND expires_at > ?
       RETURNING grant_id, redirect_uri, code_challenge`,
    )
      .bind(await sha256(form.code), now)
      .first<{ grant_id: string; redirect_uri: string; code_challenge: string }>();
    const grant = row
      ? await c.env.DB.prepare("SELECT client_id FROM oauth_grants WHERE id = ?").bind(row.grant_id).first<{ client_id: string }>()
      : null;
    if (!row || grant?.client_id !== client.id) return tokenError(c, "invalid_grant", "the code is invalid, used or expired");
    if (form.redirect_uri && form.redirect_uri !== row.redirect_uri) {
      return tokenError(c, "invalid_grant", "redirect_uri doesn't match");
    }
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.code_verifier))));
    if (challenge !== row.code_challenge) {
      // Someone holds a code they can't prove; drop what it would grant.
      await c.env.DB.prepare("DELETE FROM oauth_grants WHERE id = ?").bind(row.grant_id).run();
      return tokenError(c, "invalid_grant", "code_verifier doesn't match");
    }
    return issueTokens(c, row.grant_id);
  }

  if (form.grant_type === "refresh_token") {
    if (!form.refresh_token) return tokenError(c, "invalid_request", "refresh_token is required");
    // Refresh tokens rotate: each works once.
    const row = await c.env.DB.prepare(
      `DELETE FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh' AND expires_at > ?
       RETURNING grant_id`,
    )
      .bind(await sha256(form.refresh_token), now)
      .first<{ grant_id: string }>();
    const grant = row
      ? await c.env.DB.prepare("SELECT client_id FROM oauth_grants WHERE id = ?").bind(row.grant_id).first<{ client_id: string }>()
      : null;
    if (!row || grant?.client_id !== client.id) return tokenError(c, "invalid_grant", "the refresh token is invalid or expired");
    return issueTokens(c, row.grant_id);
  }

  return tokenError(c, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
});

// RFC 7009: revoking either token ends the whole grant.
oauth.options("/oauth/revoke", (c) => (cors(c), c.body(null, 204)));
oauth.post("/oauth/revoke", async (c) => {
  cors(c);
  const form = await formBody(c);
  const client = await authenticateClient(c, form);
  if (!client) return tokenError(c, "invalid_client", "unknown client or wrong secret", 401);
  if (form.token) {
    await c.env.DB.prepare(
      `DELETE FROM oauth_grants WHERE client_id = ? AND id IN (SELECT grant_id FROM oauth_tokens WHERE token_hash = ?)`,
    )
      .bind(client.id, await sha256(form.token))
      .run();
  }
  return c.body(null, 200);
});

// --- bearer tokens ------------------------------------------------------------------

export interface TokenUser {
  userId: string;
  grantId: string;
}

/** Resolves `Authorization: Bearer <access token>` to its user. */
export async function bearerUser(c: Context<App>): Promise<TokenUser | null> {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith("ewa_")) return null;
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT g.id, g.user_id, g.last_used_at FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
     WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ?`,
  )
    .bind(await sha256(token), now)
    .first<{ id: string; user_id: string; last_used_at: number | null }>();
  if (!row) return null;
  if (!row.last_used_at || now - row.last_used_at > TOUCH_INTERVAL_MS) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").bind(now, row.id).run(),
    );
  }
  return { userId: row.user_id, grantId: row.id };
}

// --- pages ----------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * A small server-rendered page for the consent flow. formTarget is where the
 * form's submission may redirect (CSP form-action covers redirects).
 */
function page(c: Context<App>, title: string, body: string, status: 200 | 400 | 401 | 403, formTarget?: string) {
  const formAction = ["'self'", formTarget ? new URL(formTarget).origin : ""].filter(Boolean).join(" ");
  c.header(
    "content-security-policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
  );
  c.header("x-frame-options", "DENY");
  // Not no-referrer: with it, the consent form's POST carries `Origin: null`,
  // which the origin check rejects. same-origin still sends nothing to the app.
  c.header("referrer-policy", "same-origin");
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
  const content = body.trimStart().startsWith("<") ? body : `<p>${esc(body)}</p>`;
  return c.html(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · everywhere</title>
<style>
  :root { color-scheme: dark; --bg: #111318; --fg: #d7dbe3; --card: #15181e; --muted: #8a91a0; --border: #262b35; --primary: #8fa8ff; --primary-fg: #0d1020; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg);
         font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  h1 { margin: 0 0 12px; font-size: 18px; font-weight: 600; }
  p { margin: 0 0 12px; } ul { margin: 0 0 12px; padding-left: 20px; } li { margin: 2px 0; }
  .muted { color: var(--muted); font-size: 13px; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }
  button { font: inherit; font-weight: 500; border-radius: 8px; padding: 8px 16px; border: 1px solid var(--primary); background: var(--primary); color: var(--primary-fg); cursor: pointer; }
  button.secondary { background: transparent; color: var(--fg); border-color: var(--border); }
  button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
</style>
</head>
<body><main><h1>${esc(title)}</h1>${content}</main></body>
</html>`,
    status,
  );
}
