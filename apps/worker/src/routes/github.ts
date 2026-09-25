import type { Project } from "@everywhere/protocol";
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomToken } from "../crypto";
import type { DeviceRpcResult } from "../hub";
import { open, seal } from "../secretbox";
import { rateLimited, tooMany } from "../security";
import type { App } from "../types";
import { requireUser } from "./auth";

// GitHub through our OAuth app: connecting an account, listing its repos, and
// cloning one onto a device. The token stays here, sealed; a clone hands it
// to the daemon through the hub for that one git clone, never to the browser.
// Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (an OAuth app whose callback
// is <PUBLIC_URL>/api/github/callback) to turn this on.

type GithubEnv = Env & { GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string };

const STATE_COOKIE = "__Host-ew_gh_state";
const SCOPES = "repo read:org";
const API = "https://api.github.com";

export interface GithubRepo {
  fullName: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  cloneUrl: string;
}

interface ApiRepo {
  full_name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  default_branch: string;
  pushed_at: string | null;
  clone_url: string;
}

const toRepo = (r: ApiRepo): GithubRepo => ({
  fullName: r.full_name,
  description: r.description,
  private: r.private,
  fork: r.fork,
  defaultBranch: r.default_branch,
  pushedAt: r.pushed_at,
  cloneUrl: r.clone_url,
});

export const github = new Hono<App>();

github.use("*", requireUser);

const env = (c: Context<App>) => c.env as GithubEnv;
const configured = (c: Context<App>) => !!(env(c).GITHUB_CLIENT_ID && env(c).GITHUB_CLIENT_SECRET);
const callbackUrl = (c: Context<App>) => new URL("/api/github/callback", c.env.PUBLIC_URL).toString();

github.get("/status", async (c) => {
  const row = await c.env.DB.prepare("SELECT login FROM github_accounts WHERE user_id = ?")
    .bind(c.var.user.id)
    .first<{ login: string }>();
  return c.json({ configured: configured(c), login: row?.login ?? null });
});

// A top-level navigation from the web app: off to GitHub to authorize.
github.get("/connect", (c) => {
  if (!configured(c)) return c.text("GitHub isn't set up on this server", 404);
  const state = randomToken(24);
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env(c).GITHUB_CLIENT_ID!);
  url.searchParams.set("redirect_uri", callbackUrl(c));
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  return c.redirect(url.toString());
});

github.get("/callback", async (c) => {
  const back = (result: string) => c.redirect(new URL(`/settings/github?result=${result}`, c.env.PUBLIC_URL).toString());
  const state = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/", secure: true });
  const code = c.req.query("code");
  if (!configured(c) || !state || c.req.query("state") !== state || !code) return back("failed");

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env(c).GITHUB_CLIENT_ID,
      client_secret: env(c).GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(c),
    }),
  });
  const tok = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string };
  if (!tok.access_token) return back("failed");
  const user = await gh<{ login: string }>(tok.access_token, "/user");
  if (!user.ok) return back("failed");

  await c.env.DB.prepare(
    `INSERT INTO github_accounts (user_id, login, token_sealed, scopes, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET login = excluded.login, token_sealed = excluded.token_sealed,
       scopes = excluded.scopes, created_at = excluded.created_at`,
  )
    .bind(c.var.user.id, user.data.login, await seal(c.env, tok.access_token), tok.scope ?? "", Date.now())
    .run();
  return back("connected");
});

github.post("/disconnect", async (c) => {
  const token = await accountToken(c);
  await c.env.DB.prepare("DELETE FROM github_accounts WHERE user_id = ?").bind(c.var.user.id).run();
  // Revoke the grant too, so the token is dead and the app leaves the user's GitHub settings.
  if (token && configured(c)) {
    const basic = btoa(`${env(c).GITHUB_CLIENT_ID}:${env(c).GITHUB_CLIENT_SECRET}`);
    await fetch(`${API}/applications/${env(c).GITHUB_CLIENT_ID}/grant`, {
      method: "DELETE",
      headers: { ...ghHeaders(), authorization: `Basic ${basic}`, "content-type": "application/json" },
      body: JSON.stringify({ access_token: token }),
    }).catch(() => {});
  }
  return c.json({});
});

/** The account's repos, most recently pushed first. */
github.get("/repos", async (c) => {
  const token = await accountToken(c);
  if (!token) return notConnected(c);
  const r = await gh<ApiRepo[]>(
    token,
    "/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member",
  );
  if (!r.ok) return ghError(c, r);
  return c.json({ repos: r.data.map(toRepo) });
});

/** One repo by owner/name: any the account can see, not only its own. */
github.get("/repos/:owner/:name", async (c) => {
  const token = await accountToken(c);
  if (!token) return notConnected(c);
  const r = await gh<ApiRepo>(token, repoPath(c.req.param("owner"), c.req.param("name")));
  if (!r.ok) return ghError(c, r);
  return c.json({ repo: toRepo(r.data) });
});

/** Clones a repo onto a device as a new project, through the hub. */
github.post("/clone", async (c) => {
  if (await rateLimited(c, `gh-clone:${c.var.user.id}`)) return tooMany(c);
  const body = await c.req.json<{ deviceId?: unknown; repo?: unknown; path?: unknown; name?: unknown }>();
  const { deviceId, repo, path, name } = body;
  if (typeof deviceId !== "string" || typeof repo !== "string" || typeof path !== "string") {
    return c.json({ error: "deviceId, repo and path are required" }, 400);
  }
  const [owner, repoName, ...rest] = repo.split("/");
  if (!owner || !repoName || rest.length) return c.json({ error: "repo must be owner/name" }, 400);
  const token = await accountToken(c);
  if (!token) return notConnected(c);
  // Looked up here, so the device only ever gets GitHub's own clone URL.
  const r = await gh<ApiRepo>(token, repoPath(owner, repoName));
  if (!r.ok) return ghError(c, r);

  const hub = c.env.HUB.get(c.env.HUB.idFromName(c.var.user.id));
  // Typed by hand: narrowing doesn't survive the stub's RPC types.
  const res = (await hub.deviceRpc(deviceId, "projects.clone", {
    url: r.data.clone_url,
    path,
    ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
    token,
  })) as DeviceRpcResult<Project>;
  if (!res.ok) return c.json({ error: res.message }, res.code === "error" ? 400 : 502);
  return c.json({ project: res.result });
});

function repoPath(owner: string, name: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name.replace(/\.git$/, ""))}`;
}

async function accountToken(c: Context<App>): Promise<string | null> {
  const row = await c.env.DB.prepare("SELECT token_sealed FROM github_accounts WHERE user_id = ?")
    .bind(c.var.user.id)
    .first<{ token_sealed: string }>();
  return row ? open(c.env, row.token_sealed) : null;
}

function notConnected(c: Context<App>) {
  return c.json({ error: "connect GitHub in Settings first" }, 409);
}

function ghHeaders(): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "everywhere",
    "x-github-api-version": "2022-11-28",
  };
}

type GhResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

async function gh<T>(token: string, path: string): Promise<GhResult<T>> {
  const res = await fetch(API + path, { headers: { ...ghHeaders(), authorization: `Bearer ${token}` } });
  if (res.ok) return { ok: true, data: (await res.json()) as T };
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return { ok: false, status: res.status, message: body.message ?? res.statusText };
}

async function ghError(c: Context<App>, r: { status: number; message: string }) {
  if (r.status === 401) {
    // Revoked on GitHub's side: forget it, so Settings offers to connect again.
    await c.env.DB.prepare("DELETE FROM github_accounts WHERE user_id = ?").bind(c.var.user.id).run();
    return c.json({ error: "GitHub access was revoked; connect it again in Settings" }, 409);
  }
  if (r.status === 404) return c.json({ error: "repository not found, or this account can't see it" }, 404);
  return c.json({ error: `GitHub: ${r.message}` }, 502);
}
