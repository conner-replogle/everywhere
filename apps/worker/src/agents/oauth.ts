// OAuth 2.1 for connected agents, so apps that connect to MCP servers by
// signing in (a ChatGPT connector, the MCP Inspector, Claude's custom
// connectors) can use /mcp without the user pasting an API key: discovery
// (RFC 9728 protected resource metadata, RFC 8414 server metadata), dynamic
// client registration (RFC 7591), the authorization code flow with PKCE (S256
// only) behind a consent page, and rotating refresh tokens.
//
// Approving an app on the consent page (with the password and 2FA code, as
// for an API key) makes a key for it: a name, scopes, devices and an expiry
// picked there. Its tokens act as that key, so it shows under Settings →
// Connected agents with the keys, its tool calls are logged as the key's, and
// deleting it (or turning connected agents off) disconnects the app. Nothing
// here answers while connected agents are off.
import { Hono } from "hono";
import type { Context } from "hono";
import { sessionUser } from "../auth";
import { b64url, randomId, randomToken, sha256 } from "../crypto";
import { clientIp, rateLimited } from "../security";
import type { App } from "../types";
import {
  ACCESS_PREFIX,
  agentsOn,
  DAY_MS,
  EXPIRY_DAYS,
  mcpUrl,
  parseScopes,
  reauthProblem,
  SCOPES,
  type Scope,
} from "./keys";

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
/** Registered clients nobody approved are dropped after this long. */
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRY_DAYS = 30;
const REFRESH_PREFIX = "ewr_";

/** What each scope lets an app do, in words (as on the settings page). */
const SCOPE_WORDS: Record<Scope, string> = {
  read: "see your devices, projects and threads, and read threads",
  drive: "start Claude threads, prompt them, stop them and change them",
  projects: "create projects and list folders",
};

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

/** Where /mcp's 401s point clients (WWW-Authenticate resource_metadata). */
export function resourceMetadataUrl(env: Env): string {
  return `${env.PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`;
}

// None of it exists while connected agents are off (the consent page says so instead).
async function whileOn(c: Context<App>, next: () => Promise<void>) {
  if (c.req.path === "/oauth/authorize") return next();
  if (!(await agentsOn(c.env))) {
    cors(c);
    return c.json({ error: "not found" }, 404);
  }
  await next();
}
oauth.use("/oauth/*", whileOn);
oauth.use("/.well-known/*", whileOn);

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
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/settings/agents`,
  };
}

for (const path of [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
  "/.well-known/openid-configuration",
  "/.well-known/openid-configuration/mcp",
]) {
  oauth.options(path, (c) => (cors(c), c.body(null, 204)));
  oauth.get(path, (c) => (cors(c), c.json(serverMetadata(c.env))));
}

for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
  oauth.options(path, (c) => (cors(c), c.body(null, 204)));
  oauth.get(path, (c) => {
    cors(c);
    return c.json({
      resource: mcpUrl(c.env),
      authorization_servers: [c.env.PUBLIC_URL],
      bearer_methods_supported: ["header"],
      scopes_supported: [...SCOPES],
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
  const name = (typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim() : "Unnamed app").slice(0, 60);

  const now = Date.now();
  const id = `ewc_${randomId()}`;
  const secret = authMethod === "none" ? null : `ews_${randomToken()}`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM oauth_clients WHERE created_at < ?
       AND id NOT IN (SELECT client_id FROM agent_keys WHERE client_id IS NOT NULL)`,
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
      scope: SCOPES.join(" "),
    },
    201,
  );
});

async function getClient(env: Env, id: string | undefined): Promise<ClientRow | null> {
  if (!id || id.length > 100) return null;
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
  /** The scopes the app asked for (preticked on the consent page). */
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
    response: c.redirect(withParams(redirectUri, { error, error_description: description, state: q.state, iss: c.env.PUBLIC_URL }), 302),
  });
  if (q.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
  if (!q.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) {
    return fail("invalid_request", "a PKCE code_challenge is required");
  }
  if ((q.code_challenge_method ?? "plain") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  if (q.resource && !sameResource(q.resource, mcpUrl(c.env))) {
    return fail("invalid_target", `unknown resource; use ${mcpUrl(c.env)}`);
  }
  return {
    ok: true,
    client,
    params: {
      client_id: client.id,
      redirect_uri: redirectUri,
      code_challenge: q.code_challenge,
      state: q.state ?? "",
      scope: parseScopes(q.scope).join(" "),
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

/** What the consent form holds: preticked from the request, or as the user left it. */
interface Choices {
  name: string;
  scopes: Scope[];
  devices: string[];
  days: number;
}

async function ownDevices(env: Env, userId: string): Promise<{ id: string; name: string }[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, name FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY name",
  )
    .bind(userId)
    .all<{ id: string; name: string }>();
  return results;
}

async function hasTotp(env: Env, userId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND totp_secret IS NOT NULL").bind(userId).first());
}

async function consentPage(
  c: Context<App>,
  s: { user: { id: string; username: string }; sessionId: string },
  client: ClientRow,
  params: AuthorizeParams,
  choices: Choices,
  error?: string,
) {
  const [devices, totp] = await Promise.all([ownDevices(c.env, s.user.id), hasTotp(c.env, s.user.id)]);
  const host = new URL(params.redirect_uri).host;
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
    .join("");
  const scopes = SCOPES.map(
    (sc) => `<label class="check"><input type="checkbox" name="scopes" value="${sc}"${
      choices.scopes.includes(sc) || sc === "read" ? " checked" : ""
    }${sc === "read" ? " disabled" : ""}> <span>${esc(SCOPE_WORDS[sc])}</span></label>`,
  ).join("");
  const deviceBoxes = devices.length
    ? devices
        .map(
          (d) => `<label class="check"><input type="checkbox" name="devices" value="${esc(d.id)}"${
            choices.devices.includes(d.id) ? " checked" : ""
          }> <span>${esc(d.name)}</span></label>`,
        )
        .join("")
    : `<p class="muted">No devices enrolled yet.</p>`;
  const expiry = EXPIRY_DAYS.map(
    (d) => `<option value="${d}"${d === choices.days ? " selected" : ""}>${d} days</option>`,
  ).join("");
  return page(
    c,
    `Connect ${client.name}?`,
    `<p><strong>${esc(client.name)}</strong> wants to act as <strong>${esc(s.user.username)}</strong> on everywhere,
     as a connected agent. You'll be sent back to <strong>${esc(host)}</strong>; only continue if you started this.</p>
     <form method="post" action="/oauth/authorize">
       ${hidden}<input type="hidden" name="csrf" value="${await consentToken(s.sessionId)}">
       <label class="field">Name <span class="muted">(threads show it on the prompts it sends)</span>
         <input name="name" maxlength="60" required value="${esc(choices.name)}"></label>
       <fieldset><legend>It may</legend>${scopes}</fieldset>
       <fieldset><legend>On these devices</legend>${deviceBoxes}
         <p class="muted">Each device's own switch for connected agents must be on too.</p></fieldset>
       <label class="field">Until it expires in <select name="days">${expiry}</select></label>
       <p class="muted">What it reads goes to whoever runs ${esc(client.name)}, and text in a thread or a web page
       can try to steer it. It can't run commands, read other files, use terminals or answer Claude's permission
       prompts. Disconnect it any time under Settings → Connected agents.</p>
       <label class="field">Password <input type="password" name="password" autocomplete="current-password" required></label>
       ${
         totp
           ? `<label class="field">Authenticator or recovery code
                <input name="code" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" required></label>`
           : ""
       }
       ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
       <div class="actions">
         <button name="decision" value="deny" class="secondary" formnovalidate>Cancel</button>
         <button name="decision" value="allow">Allow</button>
       </div>
     </form>`,
    error ? 400 : 200,
    params.redirect_uri,
  );
}

oauth.get("/oauth/authorize", async (c) => {
  const s = await sessionUser(c);
  if (!s) {
    const back = new URL(c.req.url);
    return c.redirect(`/login?redirect=${encodeURIComponent(back.pathname + back.search)}`, 302);
  }
  if (!(await agentsOn(c.env))) {
    return page(
      c,
      "Connected agents are off",
      "Turn on connected agents under Settings → Connected agents, then connect the app again.",
      403,
    );
  }
  const checked = await checkAuthorize(c, c.req.query());
  if (!checked.ok) return checked.response;
  const { client, params } = checked;
  const devices = await ownDevices(c.env, s.user.id);
  const asked = parseScopes(params.scope);
  return consentPage(c, s, client, params, {
    name: client.name,
    scopes: asked.length ? asked : ["read", "drive"],
    devices: devices.length === 1 ? [devices[0]!.id] : [],
    days: DEFAULT_EXPIRY_DAYS,
  });
});

oauth.post("/oauth/authorize", async (c) => {
  const s = await sessionUser(c);
  if (!s) return page(c, "Signed out", "Your session ended. Start connecting the app again.", 401);
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.env.PUBLIC_URL).origin && origin !== new URL(c.req.url).origin) {
    return page(c, "Invalid request", "This form was submitted from another site.", 403);
  }
  if (!(await agentsOn(c.env))) {
    return page(c, "Connected agents are off", "Turn on connected agents, then connect the app again.", 403);
  }
  const form = await c.req.parseBody({ all: true });
  const one = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : undefined);
  const many = (k: string) => {
    const v = form[k];
    return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
  };
  if (one("csrf") !== (await consentToken(s.sessionId))) {
    return page(c, "Invalid request", "This form expired. Start connecting the app again.", 403);
  }
  const checked = await checkAuthorize(c, {
    client_id: one("client_id"),
    redirect_uri: one("redirect_uri"),
    code_challenge: one("code_challenge"),
    state: one("state"),
    scope: one("scope"),
    response_type: "code",
    code_challenge_method: "S256",
  });
  if (!checked.ok) return checked.response;
  const { client, params } = checked;
  if (one("decision") !== "allow") {
    return c.redirect(
      withParams(params.redirect_uri, {
        error: "access_denied",
        error_description: "the user declined",
        state: params.state,
        iss: c.env.PUBLIC_URL,
      }),
      302,
    );
  }

  const owned = new Set((await ownDevices(c.env, s.user.id)).map((d) => d.id));
  const days = EXPIRY_DAYS.find((d) => d === Number(one("days"))) ?? DEFAULT_EXPIRY_DAYS;
  const choices: Choices = {
    name: (one("name") ?? "").trim().slice(0, 60),
    scopes: parseScopes(["read", ...many("scopes")].join(" ")),
    devices: [...new Set(many("devices"))].filter((d) => owned.has(d)),
    days,
  };
  const again = (error: string) => consentPage(c, s, client, params, choices, error);
  if (!choices.name) return again("Give it a name.");
  if (choices.devices.length === 0) return again("Pick at least one device.");
  const denied = await reauthProblem(c, s.user.id, one("password"), one("code"));
  if (denied) return again(denied.error.charAt(0).toUpperCase() + denied.error.slice(1) + ".");

  // The app's key. Nobody holds a secret for it; its tokens stand in.
  const keyId = randomId();
  const code = randomToken();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(now),
    c.env.DB.prepare(
      `INSERT INTO agent_keys (id, user_id, name, key_hash, hint, scopes, devices, created_at, expires_at, client_id)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
    ).bind(
      keyId,
      s.user.id,
      choices.name,
      await sha256(`oauth:${randomToken()}`),
      choices.scopes.join(" "),
      JSON.stringify(choices.devices),
      now,
      now + days * DAY_MS,
      client.id,
    ),
    c.env.DB.prepare(
      "INSERT INTO oauth_codes (code_hash, key_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(await sha256(code), keyId, params.redirect_uri, params.code_challenge, now + CODE_TTL_MS),
  ]);
  return c.redirect(withParams(params.redirect_uri, { code, state: params.state, iss: c.env.PUBLIC_URL }), 302);
});

// --- tokens ---------------------------------------------------------------------

function tokenError(c: Context<App>, error: string, description: string, status: 400 | 401 | 429 = 400) {
  return c.json({ error, error_description: description }, status);
}

/** The client authenticating at the token endpoint (secret, or none for public clients). */
async function authenticateClient(c: Context<App>, form: Record<string, string | undefined>): Promise<ClientRow | null> {
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

interface KeyInfo {
  id: string;
  client_id: string | null;
  scopes: string;
  expires_at: number;
}

async function keyFor(env: Env, keyId: string): Promise<KeyInfo | null> {
  return env.DB.prepare("SELECT id, client_id, scopes, expires_at FROM agent_keys WHERE id = ? AND expires_at > ?")
    .bind(keyId, Date.now())
    .first<KeyInfo>();
}

/** A new access and refresh token for the key; neither outlives it. */
async function issueTokens(c: Context<App>, key: KeyInfo) {
  const now = Date.now();
  const access = `${ACCESS_PREFIX}${randomToken()}`;
  const refresh = `${REFRESH_PREFIX}${randomToken()}`;
  const accessExpires = Math.min(now + ACCESS_TTL_MS, key.expires_at);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_tokens WHERE key_id = ? AND expires_at < ?").bind(key.id, now),
    c.env.DB.prepare("INSERT INTO oauth_tokens (token_hash, key_id, kind, expires_at) VALUES (?, ?, 'access', ?)").bind(
      await sha256(access),
      key.id,
      accessExpires,
    ),
    c.env.DB.prepare("INSERT INTO oauth_tokens (token_hash, key_id, kind, expires_at) VALUES (?, ?, 'refresh', ?)").bind(
      await sha256(refresh),
      key.id,
      key.expires_at,
    ),
  ]);
  return c.json({
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.max(1, Math.floor((accessExpires - now) / 1000)),
    refresh_token: refresh,
    scope: parseScopes(key.scopes).join(" "),
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
       RETURNING key_id, redirect_uri, code_challenge`,
    )
      .bind(await sha256(form.code), now)
      .first<{ key_id: string; redirect_uri: string; code_challenge: string }>();
    const key = row ? await keyFor(c.env, row.key_id) : null;
    if (!row || !key || key.client_id !== client.id) return tokenError(c, "invalid_grant", "the code is invalid, used or expired");
    if (form.redirect_uri && form.redirect_uri !== row.redirect_uri) {
      return tokenError(c, "invalid_grant", "redirect_uri doesn't match");
    }
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.code_verifier))));
    if (challenge !== row.code_challenge) {
      // Someone holds a code they can't prove; drop the key it would act as.
      await c.env.DB.prepare("DELETE FROM agent_keys WHERE id = ?").bind(key.id).run();
      return tokenError(c, "invalid_grant", "code_verifier doesn't match");
    }
    return issueTokens(c, key);
  }

  if (form.grant_type === "refresh_token") {
    if (!form.refresh_token) return tokenError(c, "invalid_request", "refresh_token is required");
    // Refresh tokens rotate: each works once.
    const row = await c.env.DB.prepare(
      `DELETE FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh' AND expires_at > ?
       RETURNING key_id`,
    )
      .bind(await sha256(form.refresh_token), now)
      .first<{ key_id: string }>();
    const key = row ? await keyFor(c.env, row.key_id) : null;
    if (!key || key.client_id !== client.id) return tokenError(c, "invalid_grant", "the refresh token is invalid or expired");
    return issueTokens(c, key);
  }

  return tokenError(c, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
});

// RFC 7009: revoking either token disconnects the app (deletes its key).
oauth.options("/oauth/revoke", (c) => (cors(c), c.body(null, 204)));
oauth.post("/oauth/revoke", async (c) => {
  cors(c);
  const form = await formBody(c);
  const client = await authenticateClient(c, form);
  if (!client) return tokenError(c, "invalid_client", "unknown client or wrong secret", 401);
  if (form.token) {
    await c.env.DB.prepare(
      `DELETE FROM agent_keys WHERE client_id = ? AND id IN (SELECT key_id FROM oauth_tokens WHERE token_hash = ?)`,
    )
      .bind(client.id, await sha256(form.token))
      .run();
  }
  return c.body(null, 200);
});

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
  :root { color-scheme: dark; --bg: #111318; --fg: #d7dbe3; --card: #15181e; --muted: #8a91a0; --border: #262b35; --primary: #8fa8ff; --primary-fg: #0d1020; --error: #ff8a8a; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg);
         font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 460px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  h1 { margin: 0 0 12px; font-size: 18px; font-weight: 600; }
  p { margin: 0 0 12px; }
  .muted { color: var(--muted); font-size: 13px; }
  .error { color: var(--error); }
  form { display: grid; gap: 14px; }
  form p { margin: 0; }
  fieldset { margin: 0; padding: 0; border: 0; display: grid; gap: 6px; }
  legend { font-weight: 500; margin-bottom: 6px; padding: 0; }
  .check { display: flex; gap: 8px; align-items: baseline; }
  .field { display: grid; gap: 6px; font-weight: 500; }
  .field .muted { font-weight: 400; }
  input:not([type]), input[type=password], select { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--border);
         border-radius: 8px; padding: 7px 10px; width: 100%; }
  input[type=checkbox] { accent-color: var(--primary); }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
  button { font: inherit; font-weight: 500; border-radius: 8px; padding: 8px 16px; border: 1px solid var(--primary); background: var(--primary); color: var(--primary-fg); cursor: pointer; }
  button.secondary { background: transparent; color: var(--fg); border-color: var(--border); }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
</style>
</head>
<body><main><h1>${esc(title)}</h1>${content}</main></body>
</html>`,
    status,
  );
}
