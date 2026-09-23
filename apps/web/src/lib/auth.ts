// Cached session state so route guards don't hit /api/auth/me on every navigation.

import { useSyncExternalStore } from "react";
import { api, type Me } from "./api";
import { devices } from "./devices";
import { hub } from "./hub";
import { disposeAllPeers } from "./peer";

let current: Me | null = null;
let inflight: Promise<Me> | null = null;
const listeners = new Set<() => void>();

function set(me: Me): void {
  current = me;
  for (const fn of listeners) fn();
}

export const auth = {
  /** Resolves the session, fetching once and caching thereafter. */
  async load(force = false): Promise<Me> {
    if (current && !force) return current;
    inflight ??= api.me().finally(() => {
      inflight = null;
    });
    const me = await inflight;
    set(me);
    return me;
  },

  async login(username: string, password: string): Promise<void> {
    const { user } = await api.login(username, password);
    set({ user, signupOpen: false });
  },

  async signup(username: string, password: string): Promise<void> {
    const { user } = await api.signup(username, password);
    set({ user, signupOpen: false });
  },

  async logout(): Promise<void> {
    try {
      await api.logout();
    } finally {
      this.clear();
    }
  },

  /** Drop all session-bound state (after logout or when the session expires). */
  clear(): void {
    hub.stop();
    disposeAllPeers();
    devices.reset();
    set({ user: null, signupOpen: current?.signupOpen ?? false });
  },
};

export function useAuth(): Me | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}
