// Account preferences, kept by the Worker so every browser shares them.
// Loaded once after sign-in; changes apply here at once and sync behind.

import type { PermissionMode } from "@everywhere/protocol";
import { useSyncExternalStore } from "react";
import { api } from "@/lib/api";

export interface Prefs {
  /** The permission mode new claude threads start in. */
  defaultPermissionMode: PermissionMode;
  /** Ask claude for a recap when returning to a thread left idle a while. */
  autoRecap: boolean;
}

const DEFAULTS: Prefs = { defaultPermissionMode: "auto", autoRecap: true };

let prefs: Prefs = DEFAULTS;
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: Prefs): void {
  prefs = next;
  for (const fn of listeners) fn();
}

function load(): Promise<void> {
  loaded ??= api.prefs().then(
    (p) => set({ ...DEFAULTS, ...p }),
    () => {
      loaded = null; // try again next time
    },
  );
  return loaded;
}

/** The preferences, fetched on first use. */
export async function getPrefs(): Promise<Prefs> {
  await load();
  return prefs;
}

export async function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void> {
  const before = prefs;
  set({ ...prefs, [key]: value });
  try {
    set({ ...DEFAULTS, ...(await api.setPrefs({ [key]: value })) });
  } catch (e) {
    set(before);
    throw e;
  }
}

export function usePrefs(): Prefs {
  void load();
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => prefs,
  );
}
