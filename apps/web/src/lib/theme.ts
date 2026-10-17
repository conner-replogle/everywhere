// Colors: one of the built-in themes, or the Omarchy desktop's own through
// the omarchy-theme extension (extensions/omarchy-theme). Each is an Omarchy
// colors.toml, turned into the CSS tokens of styles.css and the terminal's
// palette (--term-*, which terminal-view.tsx reads), set on <html>.
//
// The choice is per browser: the Omarchy theme only exists where the
// extension is. Without a choice, Omarchy's wins where there is one.

import { useSyncExternalStore } from "react";
import { OMARCHY_THEMES } from "./omarchy-themes";

/** An Omarchy colors.toml, as far as it's used here. */
export interface Palette {
  mode?: string;
  background: string;
  foreground: string;
  accent?: string;
  selection?: string;
  muted?: string;
  dark_background?: string;
  bright_foreground?: string;
  red?: string;
  yellow?: string;
  green?: string;
  cyan?: string;
  blue?: string;
  magenta?: string;
  bright_red?: string;
  bright_yellow?: string;
  bright_green?: string;
  bright_cyan?: string;
  bright_blue?: string;
  bright_magenta?: string;
}

export interface Theme {
  id: string;
  name: string;
  colors: Palette;
}

/** everywhere's colors before themes. */
const ORIGINAL: Theme = {
  id: "everywhere",
  name: "Everywhere",
  colors: {
    mode: "dark",
    background: "#111318",
    foreground: "#d7dbe3",
    accent: "#8fa8ff",
    muted: "#5c6370",
    dark_background: "#14171c",
    bright_foreground: "#f2f4f8",
    red: "#f07178",
    yellow: "#e8c46a",
    green: "#8fd694",
    cyan: "#6fd3d8",
    blue: "#82aaff",
    magenta: "#c79bf2",
    bright_red: "#ff8a91",
    bright_yellow: "#f5d58a",
    bright_green: "#a6e6aa",
    bright_cyan: "#8fe6ea",
    bright_blue: "#a3c0ff",
    bright_magenta: "#dbb5ff",
  },
};

export const THEMES: Theme[] = [...OMARCHY_THEMES, ORIGINAL];

/** Also what styles.css starts with, so the first paint matches. */
export const DEFAULT_THEME = "miasma";

/** The theme choice that follows the Omarchy desktop. */
export const OMARCHY = "omarchy";

const HEX = /^#[0-9a-f]{6}$/i;

// Omarchy's own mixing: a straight blend in sRGB, pct of b.
function mix(a: string, b: string, pct: number): string {
  const channel = (i: number) => {
    const x = Number.parseInt(a.slice(i, i + 2), 16);
    const y = Number.parseInt(b.slice(i, i + 2), 16);
    return Math.round(x + ((y - x) * pct) / 100)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

// A color in OKLab, for telling how far apart two look.
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function distance(a: string, b: string): number {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/**
 * Four chart series colors from the theme: the accent, then each time the
 * color farthest from those picked and not too close to the background.
 * Red is left out, for failures.
 */
export function chartColors(c: Palette, accent: string): string[] {
  const pool = [
    c.blue, c.cyan, c.magenta, c.yellow, c.green,
    c.bright_blue, c.bright_cyan, c.bright_magenta, c.bright_yellow, c.bright_green,
  ].filter((h): h is string => !!h && HEX.test(h));
  const picked = [accent];
  while (picked.length < 4 && pool.length > 0) {
    let best = pool[0]!;
    let bestScore = -1;
    for (const h of pool) {
      const score = Math.min(...picked.map((p) => distance(p, h)), distance(h, c.background) / 2);
      if (score > bestScore) [best, bestScore] = [h, score];
    }
    picked.push(best);
  }
  return picked;
}

export function variables(c: Palette): Record<string, string | undefined> {
  const bg = c.background;
  const fg = c.foreground;
  const accent = c.accent ?? c.blue ?? fg;
  const red = c.red ?? "#f06a6a";
  const surface = (pct: number) => mix(bg, fg, pct);
  const chart = chartColors(c, accent);
  return {
    "--background": bg,
    "--foreground": fg,
    "--card": surface(3),
    "--card-foreground": fg,
    "--popover": surface(6),
    "--popover-foreground": fg,
    "--primary": accent,
    "--primary-foreground": bg,
    "--secondary": surface(9),
    "--secondary-foreground": fg,
    "--muted": surface(6),
    "--muted-foreground": mix(fg, bg, 38),
    "--accent": surface(10),
    "--accent-foreground": fg,
    "--destructive": mix(red, fg, 25),
    "--destructive-foreground": bg,
    "--border": surface(12),
    "--input": surface(16),
    "--ring": accent,
    "--live": c.green ?? "#5fd4a3",
    "--warn": c.yellow ?? "#e8b45a",
    "--sidebar": c.dark_background ?? mix(bg, "#000000", 15),
    "--terminal": bg,
    "--chart-1": chart[0],
    "--chart-2": chart[1] ?? accent,
    "--chart-3": chart[2] ?? accent,
    "--chart-4": chart[3] ?? accent,

    // As Omarchy colors its terminals (default/themed/alacritty.toml.tpl).
    "--term-background": bg,
    "--term-foreground": fg,
    "--term-cursor": c.bright_foreground ?? fg,
    "--term-cursor-accent": bg,
    "--term-selection-background": c.selection ?? surface(20),
    "--term-black": bg,
    "--term-red": red,
    "--term-green": c.green,
    "--term-yellow": c.yellow,
    "--term-blue": c.blue,
    "--term-magenta": c.magenta,
    "--term-cyan": c.cyan,
    "--term-white": fg,
    "--term-bright-black": c.muted,
    "--term-bright-red": c.bright_red ?? red,
    "--term-bright-green": c.bright_green ?? c.green,
    "--term-bright-yellow": c.bright_yellow ?? c.yellow,
    "--term-bright-blue": c.bright_blue ?? c.blue,
    "--term-bright-magenta": c.bright_magenta ?? c.magenta,
    "--term-bright-cyan": c.bright_cyan ?? c.cyan,
    "--term-bright-white": c.bright_foreground ?? fg,
  };
}

// The Omarchy theme, as the extension leaves it on <html>:
// data-omarchy-theme='{"name":"miasma","colors":{...}}'.
function readOmarchy(): Theme | null {
  const raw = document.documentElement.dataset.omarchyTheme;
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as { name?: unknown; colors?: Record<string, unknown> | null };
    const colors: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.colors ?? {})) {
      if (typeof v === "string" && (k === "mode" || HEX.test(v))) colors[k] = v.toLowerCase();
    }
    if (!colors.background || !colors.foreground) return null;
    const name = typeof t.name === "string" && t.name ? t.name : "Omarchy";
    return { id: OMARCHY, name, colors: colors as unknown as Palette };
  } catch {
    return null;
  }
}

const KEY = "everywhere.theme";
// Where storage is blocked, the choice lasts as long as the page.
let unsaved: string | null = null;

function readChoice(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return unsaved;
  }
}

export interface ThemeState {
  /** What was picked here, if anything. */
  choice: string | null;
  /** The Omarchy desktop's theme, where the extension is. */
  omarchy: Theme | null;
  /** What's showing. */
  theme: Theme;
}

function resolve(choice: string | null, omarchy: Theme | null): ThemeState {
  const fallback = THEMES.find((t) => t.id === DEFAULT_THEME) ?? ORIGINAL;
  const theme =
    (choice === OMARCHY || choice === null ? omarchy : THEMES.find((t) => t.id === choice)) ?? fallback;
  return { choice, omarchy, theme };
}

let state: ThemeState = { choice: null, omarchy: null, theme: ORIGINAL };
let applied: string[] = [];
const listeners = new Set<() => void>();

function meta(name: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.name = name;
    document.head.append(el);
  }
  el.content = content;
}

function update() {
  state = resolve(readChoice(), readOmarchy());
  const root = document.documentElement;
  for (const name of applied) root.style.removeProperty(name);
  applied = [];
  for (const [name, value] of Object.entries(variables(state.theme.colors))) {
    if (!value) continue;
    root.style.setProperty(name, value);
    applied.push(name);
  }
  const scheme = state.theme.colors.mode === "light" ? "light" : "dark";
  root.style.colorScheme = scheme;
  meta("theme-color", state.theme.colors.background);
  meta("color-scheme", scheme);
  for (const fn of listeners) fn();
}

/** Applies the theme now, and again when the choice or the Omarchy theme changes. */
export function startTheme(): void {
  update();
  new MutationObserver(update).observe(document.documentElement, { attributeFilter: ["data-omarchy-theme"] });
  // Another tab picked one.
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) update();
  });
}

/** A theme id, OMARCHY, or null for the default. */
export function setTheme(choice: string | null): void {
  try {
    if (choice === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    unsaved = choice;
  }
  update();
}

export function useTheme(): ThemeState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}
