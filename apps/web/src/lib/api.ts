// REST wrappers for the Worker (auth, device registry, enrollment).

export interface User {
  id: string;
  username: string;
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

export interface EnrollToken {
  command: string;
  expiresAt: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export const api = {
  me: () => request<Me>("GET", "/api/auth/me"),
  signup: (username: string, password: string) =>
    request<{ user: User }>("POST", "/api/auth/signup", { username, password }),
  login: (username: string, password: string) =>
    request<{ user: User }>("POST", "/api/auth/login", { username, password }),
  logout: () => request<object>("POST", "/api/auth/logout"),

  devices: async () => (await request<{ devices: Device[] }>("GET", "/api/devices")).devices,
  renameDevice: (id: string, name: string) =>
    request<object>("PATCH", `/api/devices/${encodeURIComponent(id)}`, { name }),
  removeDevice: (id: string) => request<object>("DELETE", `/api/devices/${encodeURIComponent(id)}`),

  createEnrollToken: () => request<EnrollToken>("POST", "/api/enroll-tokens"),
};
