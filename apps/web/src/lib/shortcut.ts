// Keyboard shortcuts the user can change, kept per browser (keyboards and
// what the OS or window manager takes differ from machine to machine).
// A shortcut is written as modifiers then a key: "Ctrl+Shift+F", "Meta+K",
// with "Mod" meaning Meta on Apple devices and Ctrl elsewhere.

import { useSyncExternalStore } from "react";

export const isApple = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
type Modifier = (typeof MODIFIERS)[number];

export interface Chord {
  mods: ReadonlySet<Modifier>;
  key: string;
}

/** Parses "Mod+Shift+F"; undefined when it isn't modifiers and one key. */
export function parseShortcut(s: string, apple = isApple): Chord | undefined {
  const parts = s.split("+").map((p) => p.trim());
  // "Ctrl++" is Ctrl and the + key.
  if (parts.length > 1 && parts.at(-1) === "" && parts.at(-2) === "") parts.splice(-2, 2, "+");
  const key = parts.pop();
  if (!key) return undefined;
  const mods = new Set<Modifier>();
  for (const p of parts) {
    const m = p.toLowerCase() === "mod" ? (apple ? "Meta" : "Ctrl") : MODIFIERS.find((x) => x.toLowerCase() === p.toLowerCase());
    if (!m) return undefined;
    mods.add(m);
  }
  return { mods, key: normKey(key) };
}

function normKey(k: string): string {
  if (k.length === 1) return k.toUpperCase();
  const named: Record<string, string> = { space: "Space", " ": "Space", esc: "Escape", escape: "Escape", enter: "Enter" };
  return named[k.toLowerCase()] ?? k;
}

/** The key of a keydown, by its place on the keyboard for letters and digits (so Shift or Alt don't change it). */
export function eventKey(e: Pick<KeyboardEvent, "key" | "code">): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (e.code === "Space" || e.key === " ") return "Space";
  return normKey(e.key);
}

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

export function matches(e: KeyLike, chord: Chord): boolean {
  return (
    e.ctrlKey === chord.mods.has("Ctrl") &&
    e.altKey === chord.mods.has("Alt") &&
    e.shiftKey === chord.mods.has("Shift") &&
    e.metaKey === chord.mods.has("Meta") &&
    eventKey(e) === chord.key
  );
}

/**
 * The shortcut a keydown would set, while recording one: undefined for a
 * lone modifier, or a key with no modifier but Shift (that's typing).
 */
export function recordShortcut(e: KeyLike): string | undefined {
  if (["Control", "Alt", "Shift", "Meta", "OS", "AltGraph"].includes(e.key)) return undefined;
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return undefined;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean);
  return [...mods, eventKey(e)].join("+");
}

/** How a shortcut is shown: with the platform's symbols on Apple devices. */
export function formatShortcut(s: string, apple = isApple): string {
  const c = parseShortcut(s, apple);
  if (!c) return s;
  const order: Modifier[] = apple ? ["Ctrl", "Alt", "Shift", "Meta"] : ["Ctrl", "Meta", "Alt", "Shift"];
  const sym: Record<Modifier, string> = apple
    ? { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" }
    : { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Super" };
  const mods = order.filter((m) => c.mods.has(m)).map((m) => sym[m]);
  return apple ? mods.join("") + c.key : [...mods, c.key].join("+");
}

// --- the search shortcut ------------------------------------------------------

/**
 * Cmd+K on Apple devices. Elsewhere Ctrl+K is the shell's kill-line, which a
 * page-wide shortcut would take from every terminal, so Ctrl+Shift+F.
 */
export const DEFAULT_SEARCH_SHORTCUT = isApple ? "Meta+K" : "Ctrl+Shift+F";
const KEY = "ew:search-shortcut";

let current = read();
const listeners = new Set<() => void>();

function read(): string {
  try {
    const v = localStorage.getItem(KEY);
    return v && parseShortcut(v) ? v : DEFAULT_SEARCH_SHORTCUT;
  } catch {
    return DEFAULT_SEARCH_SHORTCUT;
  }
}

export function setSearchShortcut(s: string | null): void {
  try {
    if (s === null || s === DEFAULT_SEARCH_SHORTCUT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, s);
  } catch {
    // storage blocked: lasts until reload
  }
  current = s ?? DEFAULT_SEARCH_SHORTCUT;
  for (const fn of listeners) fn();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    current = read();
    for (const fn of listeners) fn();
  });
}

export function useSearchShortcut(): string {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}
