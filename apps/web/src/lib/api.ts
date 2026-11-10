// REST wrappers for the Worker (auth, device registry, enrollment, GitHub, connected agents).

import type { PluginSettingView, Project } from "@everywhere/protocol";
import type { Prefs } from "@/lib/prefs";

export interface User {
  id: string;
  username: string;
  totpEnabled: boolean;
  recoveryCodesLeft: number;
}

export interface Me {
  user: User | null;
  signupOpen: boolean;
}

export interface Device {
  id: string;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  version: string;
  createdAt: number;
  lastSeenAt: number | null;
}


export type LoginResult = { user: User; mfaRequired?: undefined } | { mfaRequired: true; challenge: string };

export interface TotpSetup {
  /** Base32 secret, for manual entry. */
  secret: string;
  otpauthUri: string;
}

export interface Session {
  id: string;
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  userAgent: string | null;
}

/** Enforced by the Worker on signup and password change. */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;
export const PASSWORD_HINT = `${PASSWORD_MIN}–${PASSWORD_MAX} characters.`;

export interface EnrollToken {
  command: string;
  /** The PowerShell command for Windows. */
  windowsCommand: string;
  expiresAt: number;
}

/** A GitHub repo the connected account can see. */
export interface GithubRepo {
  fullName: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  cloneUrl: string;
}

/** Connected agents: the account switch, its MCP URL and the API keys made under it. */
export interface AgentsStatus {
  enabled: boolean;
  enabledAt?: number;
  /** The MCP endpoint a key is used with. */
  mcpUrl: string;
  keys: AgentKey[];
}

export type AgentScope = "read" | "drive" | "projects";

/** An API key a connected agent signs in with, and what it may do. */
export interface AgentKey {
  id: string;
  /** The user's label, e.g. "Claude Code on my laptop"; threads show "via <name>". */
  name: string;
  /** The secret's last 4 characters. */
  hint: string;
  /** read is always included. */
  scopes: AgentScope[];
  /** The devices it may reach, by id. */
  devices: string[];
  createdAt: number;
  lastUsedAt?: number;
  expiresAt: number;
}

export interface NewAgentKey {
  name: string;
  scopes: AgentScope[];
  devices: string[];
  expiresInDays: 7 | 30 | 90;
  password: string;
  code?: string;
}

/** One tool call a connected agent made. */
export interface AgentActivity {
  id: string;
  at: number;
  keyId: string;
  /** The key's name at the time. */
  key: string;
  /** The MCP tool's name, e.g. "send_message". */
  tool: string;
  deviceId?: string;
  threadId?: string;
  ok: boolean;
  error?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The parsed JSON error body, for extra flags like `expired`. */
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // The Worker rejects state-changing requests that aren't JSON (a CSRF
  // defense: cross-site forms can't send application/json), so every
  // non-GET carries a JSON body, even an empty one.
  const hasBody = method !== "GET" && method !== "HEAD";
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: hasBody ? { "content-type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body (e.g. a proxy error page).
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `${res.status} ${res.statusText || "request failed"}`;
    throw new ApiError(msg, res.status, data && typeof data === "object" ? (data as Record<string, unknown>) : {});
  }
  return data as T;
}

export const api = {
  me: () => request<Me>("GET", "/api/auth/me"),
  iceServers: () =>
    request<{ iceServers: RTCIceServer[]; turn: boolean; expiresAt: number }>("GET", "/api/ice-servers"),
  signup: (username: string, password: string) =>
    request<{ user: User }>("POST", "/api/auth/signup", { username, password }),
  login: (username: string, password: string) =>
    request<LoginResult>("POST", "/api/auth/login", { username, password }),
  loginMfa: (challenge: string, code: string) =>
    request<{ user: User }>("POST", "/api/auth/login/mfa", { challenge, code }),
  logout: () => request<object>("POST", "/api/auth/logout"),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<object>("POST", "/api/auth/password", { currentPassword, newPassword }),

  totpSetup: (password: string) => request<TotpSetup>("POST", "/api/auth/2fa/setup", { password }),
  totpEnable: (code: string) => request<{ recoveryCodes: string[] }>("POST", "/api/auth/2fa/enable", { code }),
  totpDisable: (password: string, code: string) =>
    request<object>("POST", "/api/auth/2fa/disable", { password, code }),
  regenerateRecoveryCodes: (code: string) =>
    request<{ recoveryCodes: string[] }>("POST", "/api/auth/2fa/recovery-codes", { code }),

  sessions: async () => (await request<{ sessions: Session[] }>("GET", "/api/auth/sessions")).sessions,
  revokeSession: (id: string) => request<object>("DELETE", `/api/auth/sessions/${encodeURIComponent(id)}`),
  revokeOtherSessions: () => request<object>("POST", "/api/auth/sessions/revoke-others"),

  devices: async () => (await request<{ devices: Device[] }>("GET", "/api/devices")).devices,
  renameDevice: (id: string, name: string) =>
    request<object>("PATCH", `/api/devices/${encodeURIComponent(id)}`, { name }),
  removeDevice: (id: string) => request<object>("DELETE", `/api/devices/${encodeURIComponent(id)}`),

  createEnrollToken: () => request<EnrollToken>("POST", "/api/enroll-tokens"),

  pushKey: async () => (await request<{ publicKey: string }>("GET", "/api/push/key")).publicKey,
  subscribePush: (sub: PushSubscriptionJSON) => request<object>("POST", "/api/push/subscriptions", sub),
  unsubscribePush: (endpoint: string) => request<object>("POST", "/api/push/unsubscribe", { endpoint }),
  testPush: (endpoint: string) => request<object>("POST", "/api/push/test", { endpoint }),

  prefs: async () => (await request<{ prefs: Partial<Prefs> }>("GET", "/api/prefs")).prefs,
  setPrefs: async (p: Partial<Prefs>) => (await request<{ prefs: Partial<Prefs> }>("PATCH", "/api/prefs", p)).prefs,

  /** The account's Claude token, as far as the app sees it: whether it's set, its last characters, when. */
  claudeToken: () => request<ClaudeTokenInfo>("GET", "/api/claude/token"),
  /** A plugin's account settings, as the browser may see them. */
  pluginSettings: (id: string) => request<Record<string, PluginSettingView>>("GET", `/api/plugin-settings/${encodeURIComponent(id)}`),
  setPluginSettings: (id: string, values: Record<string, unknown>, secrets: string[]) =>
    request<{ values: Record<string, PluginSettingView>; devices: Record<string, string> }>(
      "PUT",
      `/api/plugin-settings/${encodeURIComponent(id)}`,
      { values, secrets },
    ),
  /** Sets it, sending it to every connected device; devices maps each to "ok" or what went wrong. */
  setClaudeToken: (token: string) => request<ClaudeTokenResult>("PUT", "/api/claude/token", { token }),
  removeClaudeToken: () => request<ClaudeTokenResult>("DELETE", "/api/claude/token"),
  /** The account's custom instructions, added to every Claude thread's system prompt. */
  claudeInstructions: () => request<ClaudeInstructions>("GET", "/api/claude/instructions"),
  /** Sets them ("" clears them), sending them to every connected device; devices as for the token. */
  setClaudeInstructions: (text: string) =>
    request<ClaudeInstructions & { devices: Record<string, string> }>("PUT", "/api/claude/instructions", { text }),

  /** A clearer version of a composer draft, given the thread's recent messages. */
  rewritePrompt: (draft: string, context: { role: "user" | "claude"; text: string }[]) =>
    request<{ text: string }>("POST", "/api/prompt/rewrite", { draft, context }),

  agents: () => request<AgentsStatus>("GET", "/api/agents"),
  /** Needs the password again, and a 2FA code when it's on (else a 401 with needsCode). */
  enableAgents: (password: string, code?: string) =>
    request<{ enabled: true }>("POST", "/api/agents/enable", code ? { password, code } : { password }),
  /** Also deletes every key. */
  disableAgents: () => request<object>("POST", "/api/agents/disable"),
  /** Needs the password (and 2FA code) as enableAgents does; the secret comes back only here. */
  createAgentKey: (k: NewAgentKey) => request<{ key: AgentKey; secret: string }>("POST", "/api/agents/keys", k),
  deleteAgentKey: (id: string) => request<object>("DELETE", `/api/agents/keys/${encodeURIComponent(id)}`),
  /** Newest first; pass the answer's next back as cursor for older ones (none = no more). */
  agentActivity: (opts: { cursor?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.cursor !== undefined) q.set("cursor", opts.cursor);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return request<{ entries: AgentActivity[]; next?: string }>("GET", `/api/agents/activity${qs ? `?${qs}` : ""}`);
  },

  githubStatus: () => request<{ configured: boolean; login: string | null }>("GET", "/api/github/status"),
  /** A page navigation, not a fetch: it goes to GitHub and comes back to Settings. */
  githubConnectUrl: "/api/github/connect",
  disconnectGithub: () => request<object>("POST", "/api/github/disconnect"),
  githubRepos: async () => (await request<{ repos: GithubRepo[] }>("GET", "/api/github/repos")).repos,
  githubRepo: async (fullName: string) =>
    (await request<{ repo: GithubRepo }>("GET", `/api/github/repos/${fullName.split("/").map(encodeURIComponent).join("/")}`))
      .repo,
  cloneGithubRepo: async (deviceId: string, repo: string, path: string, name?: string) =>
    (await request<{ project: Project }>("POST", "/api/github/clone", { deviceId, repo, path, name })).project,
};

export type ClaudeTokenInfo = { set: false } | { set: true; hint: string; setAt: number };
export type ClaudeTokenResult = ClaudeTokenInfo & { devices: Record<string, string> };
export type ClaudeInstructions = { text: string; setAt?: number };
/** As the Worker allows (apps/worker/src/plugins/claude.ts). */
export const MAX_CLAUDE_INSTRUCTIONS = 16_000;
