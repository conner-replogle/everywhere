// How each thread was last laid out in this browser: the tab shown, the one
// split beside it, which side had focus, and where the divider was. Opening
// the thread again (from the sidebar, say) puts it back that way.

export interface ThreadLayout {
  /** The primary pane, if not the thread itself. */
  tab?: string;
  split?: string;
  focus?: "primary" | "split";
  /** The split's divider, as the primary pane's share. */
  ratio?: number;
  at: number;
}

const STORAGE_KEY = "ew:thread-layouts";
/** Layouts kept, the most recently used. */
const MAX = 300;

function read(): Record<string, ThreadLayout> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, ThreadLayout>) : {};
  } catch {
    return {};
  }
}

const key = (deviceId: string, threadId: string) => `${deviceId}/${threadId}`;

export function loadLayout(deviceId: string, threadId: string): ThreadLayout | undefined {
  return read()[key(deviceId, threadId)];
}

/** Merges into the thread's layout. */
export function saveLayout(deviceId: string, threadId: string, layout: Partial<Omit<ThreadLayout, "at">>): void {
  const all = read();
  const k = key(deviceId, threadId);
  const next: ThreadLayout = { ...all[k], ...layout, at: Date.now() };
  for (const f of ["tab", "split", "focus", "ratio"] as const) if (next[f] === undefined) delete next[f];
  all[k] = next;
  const entries = Object.entries(all);
  const kept =
    entries.length > MAX ? Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX)) : all;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // storage blocked: the layout lasts until the thread is left
  }
}
