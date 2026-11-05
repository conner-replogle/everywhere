// The assistant's debug log, in the browser console: one line per thing that
// happens in the live parts (the conversation's socket, the turn and its
// model calls and tools, the voices and GPT-Live's hand-offs), each tagged
// with where it came from, e.g. "[assistant:turn] model replied (stop) in
// 2.4s". Console output also goes into bug reports (console-log.ts).
//
// On by default. In the console: ewDebug.off() to quiet it, ewDebug.on() to
// bring it back (kept per browser), ewDebug.only("bridge", "turn") for some
// areas.

export type LogArea = "sync" | "turn" | "tool" | "voice" | "live" | "bridge" | "audio";

const KEY = "ew.assistant.debug";

function read(): { on: boolean; only: Set<string> | null } {
  // Not in a browser (tests): quiet.
  if (typeof window === "undefined") return { on: false, only: null };
  try {
    const v = localStorage.getItem(KEY);
    if (v === "0") return { on: false, only: null };
    if (v && v !== "1") return { on: true, only: new Set(v.split(",")) };
  } catch {}
  return { on: true, only: null };
}

let state = read();

function save(v: string | null): void {
  try {
    if (v === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch {}
  state = read();
}

if (typeof window !== "undefined") {
  (window as unknown as { ewDebug: unknown }).ewDebug = {
    on: () => save(null),
    off: () => save("0"),
    only: (...areas: LogArea[]) => save(areas.length ? areas.join(",") : null),
  };
}

const clock = () => {
  const d = new Date();
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

/** Logs one event: a short line, and the details as an object to expand. */
export function log(area: LogArea, message: string, details?: Record<string, unknown>): void {
  if (!state.on || (state.only && !state.only.has(area))) return;
  const line = `${clock()} [assistant:${area}] ${message}`;
  if (details) console.info(line, details);
  else console.info(line);
}

/** Problems: always logged, as warnings. */
export function logWarn(area: LogArea, message: string, details?: Record<string, unknown>): void {
  const line = `${clock()} [assistant:${area}] ${message}`;
  if (details) console.warn(line, details);
  else console.warn(line);
}

/** A text cut short for a log line. */
export function clip(text: string, n = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Seconds since t, for "in 2.4s". */
export function since(t: number): string {
  return `${((Date.now() - t) / 1000).toFixed(1)}s`;
}
