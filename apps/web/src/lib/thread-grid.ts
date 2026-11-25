// Threads side by side: up to four, each in a cell of the workspace with its
// own tabs. The URL names the focused cell's thread (so links, the sidebar and
// notifications work as before); the other cells are kept here, per browser.

import { useNavigate } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

export interface GridCell {
  /** Stays with the cell as threads come and go in it. */
  id: string;
  deviceId: string;
  threadId: string;
  /** The cell's thread page: its tab shown, and one split beside it. */
  tab?: string;
  split?: string;
  /** When it last had focus: a full grid gives up the longest unused cell. */
  usedAt: number;
}

export interface Grid {
  cells: GridCell[];
  focus: string;
  /** Where the dividers are, as the left column's and the top row's shares. */
  x: number;
  y: number;
}

export const MAX_CELLS = 4;
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;
const STORAGE_KEY = "ew:thread-grid";

const EMPTY: Grid = { cells: [], focus: "", x: 0.5, y: 0.5 };

const clampRatio = (r: unknown) =>
  typeof r === "number" && r >= MIN_RATIO && r <= MAX_RATIO ? r : 0.5;

let seq = 0;
const newId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A stored grid, if it still makes sense. */
export function parseGrid(raw: unknown): Grid {
  if (!raw || typeof raw !== "object") return EMPTY;
  const g = raw as Partial<Grid>;
  const cells = (Array.isArray(g.cells) ? g.cells : [])
    .filter(
      (c): c is GridCell =>
        !!c && typeof c.id === "string" && typeof c.deviceId === "string" && typeof c.threadId === "string",
    )
    .slice(0, MAX_CELLS)
    .map((c) => ({
      id: c.id,
      deviceId: c.deviceId,
      threadId: c.threadId,
      ...(typeof c.tab === "string" ? { tab: c.tab } : {}),
      ...(typeof c.split === "string" ? { split: c.split } : {}),
      usedAt: typeof c.usedAt === "number" ? c.usedAt : 0,
    }));
  const focus = cells.some((c) => c.id === g.focus) ? g.focus! : (cells[0]?.id ?? "");
  return { cells, focus, x: clampRatio(g.x), y: clampRatio(g.y) };
}

const same = (c: GridCell, deviceId: string, threadId: string) => c.deviceId === deviceId && c.threadId === threadId;

export interface Shown {
  deviceId: string;
  threadId: string;
  tab?: string;
  split?: string;
}

/**
 * The grid once the URL shows a thread: a thread already in a cell takes the
 * focus there; any other replaces the focused cell's.
 */
export function withShown(g: Grid, s: Shown, now = Date.now()): Grid {
  const tabs = { tab: s.tab, split: s.split };
  const at = g.cells.find((c) => same(c, s.deviceId, s.threadId));
  if (at) {
    if (g.focus === at.id && at.tab === s.tab && at.split === s.split) return g;
    return {
      ...g,
      focus: at.id,
      cells: g.cells.map((c) => (c.id === at.id ? { ...c, ...tabs, usedAt: now } : c)),
    };
  }
  const focused = g.cells.find((c) => c.id === g.focus);
  if (!focused) {
    const cell = { id: newId(), deviceId: s.deviceId, threadId: s.threadId, ...tabs, usedAt: now };
    return { ...g, cells: [...g.cells, cell], focus: cell.id };
  }
  return {
    ...g,
    cells: g.cells.map((c) =>
      c.id === focused.id ? { ...c, deviceId: s.deviceId, threadId: s.threadId, ...tabs, usedAt: now } : c,
    ),
  };
}

/**
 * The grid with a thread opened beside the others, and focused. With every
 * cell taken, it goes in the one unused longest (not the focused one).
 */
export function withBeside(g: Grid, deviceId: string, threadId: string, now = Date.now()): Grid {
  const at = g.cells.find((c) => same(c, deviceId, threadId));
  if (at) return { ...g, focus: at.id, cells: g.cells.map((c) => (c.id === at.id ? { ...c, usedAt: now } : c)) };
  if (g.cells.length < MAX_CELLS) {
    const cell: GridCell = { id: newId(), deviceId, threadId, usedAt: now };
    return { ...g, cells: [...g.cells, cell], focus: cell.id };
  }
  const victim = g.cells
    .filter((c) => c.id !== g.focus)
    .reduce((a, b) => (b.usedAt < a.usedAt ? b : a));
  return {
    ...g,
    focus: victim.id,
    cells: g.cells.map((c) => (c.id === victim.id ? { id: c.id, deviceId, threadId, usedAt: now } : c)),
  };
}

/** The grid without a cell; if it had the focus, the one used last takes it. */
export function withoutCell(g: Grid, id: string): Grid {
  const cells = g.cells.filter((c) => c.id !== id);
  if (cells.length === g.cells.length) return g;
  const focus =
    g.focus !== id
      ? g.focus
      : (cells.reduce<GridCell | undefined>((a, b) => (!a || b.usedAt > a.usedAt ? b : a), undefined)?.id ?? "");
  return { ...g, cells, focus };
}

/** Where each cell goes, as fractions of the grid: one, two side by side, one beside two, or two by two. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function cellRects(n: number, x: number, y: number): Rect[] {
  const full = { left: 0, top: 0, width: 1, height: 1 };
  const left = { left: 0, top: 0, width: x, height: 1 };
  const right = { left: x, top: 0, width: 1 - x, height: 1 };
  if (n <= 1) return [full];
  if (n === 2) return [left, right];
  const topRight = { left: x, top: 0, width: 1 - x, height: y };
  const bottomRight = { left: x, top: y, width: 1 - x, height: 1 - y };
  if (n === 3) return [left, topRight, bottomRight];
  return [{ left: 0, top: 0, width: x, height: y }, topRight, { left: 0, top: y, width: x, height: 1 - y }, bottomRight];
}

// The store.

let grid: Grid = (() => {
  try {
    return parseGrid(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return EMPTY;
  }
})();
const listeners = new Set<() => void>();

function set(next: Grid): void {
  if (next === grid) return;
  grid = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(grid));
  } catch {
    // Storage blocked: the grid lasts for the page.
  }
  for (const l of listeners) l();
}

export const threadGrid = {
  get: () => grid,
  show: (s: Shown) => set(withShown(grid, s)),
  beside: (deviceId: string, threadId: string) => set(withBeside(grid, deviceId, threadId)),
  close: (id: string) => set(withoutCell(grid, id)),
  focus: (id: string) => {
    if (grid.focus === id || !grid.cells.some((c) => c.id === id)) return;
    set({ ...grid, focus: id, cells: grid.cells.map((c) => (c.id === id ? { ...c, usedAt: Date.now() } : c)) });
  },
  /** A cell's own tabs, while it isn't the one the URL names. */
  setTabs: (id: string, tab: string | undefined, split: string | undefined) => {
    const c = grid.cells.find((c) => c.id === id);
    if (!c || (c.tab === tab && c.split === split)) return;
    set({ ...grid, cells: grid.cells.map((c) => (c.id === id ? { ...c, tab, split } : c)) });
  },
  /** Back to one cell, the focused one. */
  single: () => set({ ...grid, cells: grid.cells.filter((c) => c.id === grid.focus) }),
  ratios: (r: { x?: number; y?: number }) =>
    set({ ...grid, x: r.x === undefined ? grid.x : clampRatio(r.x), y: r.y === undefined ? grid.y : clampRatio(r.y) }),
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useThreadGrid(): Grid {
  return useSyncExternalStore(subscribe, threadGrid.get, threadGrid.get);
}

// A thread being dragged (from the sidebar) toward the grid.

export const THREAD_DRAG_TYPE = "application/x-everywhere-thread";

let dragging: { deviceId: string; threadId: string } | null = null;
const dragListeners = new Set<() => void>();

export const threadDrag = {
  start(deviceId: string, threadId: string) {
    dragging = { deviceId, threadId };
    for (const l of dragListeners) l();
  },
  end() {
    if (!dragging) return;
    dragging = null;
    for (const l of dragListeners) l();
  },
  get: () => dragging,
};

export function useThreadDrag() {
  return useSyncExternalStore(
    (l) => {
      dragListeners.add(l);
      return () => dragListeners.delete(l);
    },
    threadDrag.get,
    threadDrag.get,
  );
}

/** Opens a thread beside the ones shown, and goes to it. */
export function useOpenBeside(): (deviceId: string, threadId: string) => void {
  const navigate = useNavigate();
  return (deviceId, threadId) => {
    threadGrid.beside(deviceId, threadId);
    const c = grid.cells.find((c) => c.id === grid.focus);
    void navigate({
      to: "/d/$deviceId/t/$threadId",
      params: { deviceId, threadId },
      search: { ...(c?.tab ? { tab: c.tab } : {}), ...(c?.split ? { split: c.split } : {}) },
    });
  };
}
