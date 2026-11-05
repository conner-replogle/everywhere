// The page's recent console output and uncaught errors, kept for bug
// reports. Imported first in main.tsx so it sees everything from page load.

export interface ConsoleEntry {
  at: number;
  level: "error" | "warn" | "info" | "log" | "debug";
  text: string;
}

const MAX_ENTRIES = 1000;
const MAX_TEXT = 4000;
const entries: ConsoleEntry[] = [];

function format(args: unknown[]): string {
  const text = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function record(level: ConsoleEntry["level"], args: unknown[]): void {
  entries.push({ at: Date.now(), level, text: format(args) });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

for (const level of ["error", "warn", "info", "log", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    record(level, args);
    original(...args);
  };
}
window.addEventListener("error", (e) => record("error", [`Uncaught: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`, e.error]));
window.addEventListener("unhandledrejection", (e) => record("error", ["Unhandled rejection:", e.reason]));

export function consoleEntries(): ConsoleEntry[] {
  return entries.slice();
}
