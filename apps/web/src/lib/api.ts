// REST wrappers for the Worker (auth, device registry, enrollment).

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

/** An app (e.g. a ChatGPT connector) the user let use the MCP endpoint. */
export interface Connection {
  id: string;
  /** Self-reported by the app. */
  name: string;
  /** Where the app's sign-in redirects to. */
  hosts: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

export interface EnrollToken {
  command: string;
  expiresAt: number;
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

  connections: () => request<{ mcpUrl: string; connections: Connection[] }>("GET", "/api/connections"),
  revokeConnection: (id: string) => request<object>("DELETE", `/api/connections/${encodeURIComponent(id)}`),

  devices: async () => (await request<{ devices: Device[] }>("GET", "/api/devices")).devices,
  renameDevice: (id: string, name: string) =>
    request<object>("PATCH", `/api/devices/${encodeURIComponent(id)}`, { name }),
  removeDevice: (id: string) => request<object>("DELETE", `/api/devices/${encodeURIComponent(id)}`),

  createEnrollToken: () => request<EnrollToken>("POST", "/api/enroll-tokens"),
};
