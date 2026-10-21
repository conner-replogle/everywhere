import type { Process } from "@everywhere/protocol";
import type { FileReply, FrameRequest, FrameTheme, FromFrame, PluginFrameInfo } from "./bridge";

/*
 * The frame's side of the bridge: what the app has sent (the process, its
 * events, the theme), kept for the hooks, and requests to the app.
 */

type Listener = () => void;

/** A dashboard state key that has no value. */
export const UNSET = Symbol("unset");

class Store {
  process: Process | null = null;
  /** Set when the frame shows a plugin's web part. */
  plugin: PluginFrameInfo | null = null;
  private pluginListeners = new Set<(e: unknown) => void>();

  onPluginEvent(fn: (e: unknown) => void) {
    this.pluginListeners.add(fn);
    return () => {
      this.pluginListeners.delete(fn);
    };
  }

  pluginEvent(e: unknown) {
    for (const fn of this.pluginListeners) fn(e);
  }

  theme: FrameTheme = { vars: {}, dark: true };
  /** Bumped when the theme changes, for useSyncExternalStore. */
  themeVersion = 0;
  /**
   * Dashboard state set here but not yet back from the daemon, by key: shown
   * meanwhile, so a click doesn't wait for the round trip.
   */
  private pendingState = new Map<string, { value: unknown }>();
  private listeners = new Set<Listener>();

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private changed() {
    for (const fn of this.listeners) fn();
  }

  setProcess(p: Process) {
    this.process = p;
    // The daemon has it now: its copy is the one to show.
    for (const [key, pending] of this.pendingState) {
      if (sameJSON(p.dashboardState?.[key], pending.value)) this.pendingState.delete(key);
    }
    this.changed();
  }

  /**
   * A key of the dashboard's state: what was just set, or what the daemon
   * has, or UNSET. The same value until it changes, for useSyncExternalStore.
   */
  stateValue(key: string): unknown {
    const pending = this.pendingState.get(key);
    if (pending) return pending.value;
    const st = this.process?.dashboardState;
    return st && key in st ? st[key] : UNSET;
  }

  setPendingState(key: string, value: unknown) {
    this.pendingState.set(key, { value });
    this.changed();
  }

  dropPendingState(key: string) {
    if (this.pendingState.delete(key)) this.changed();
  }

  setTheme(t: FrameTheme) {
    this.theme = t;
    this.themeVersion++;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
    root.style.colorScheme = t.dark ? "dark" : "light";
    root.classList.toggle("dark", t.dark);
    this.changed();
  }

  /**
   * Telemetry changes, by experiment and metric: a count each that hooks
   * read, so they ask again when theirs moves. "*" counts any change.
   */
  private telemetry = new Map<string, number>();

  telemetryChanged(experiments: Record<string, string[]>) {
    for (const [exp, metrics] of Object.entries(experiments)) {
      for (const key of [`${exp}\u0000*`, ...metrics.map((m) => `${exp}\u0000${m}`)]) {
        this.telemetry.set(key, (this.telemetry.get(key) ?? 0) + 1);
      }
    }
    this.changed();
  }

  /** How many times a metric (or "*": anything) of an experiment changed. */
  telemetryVersion(experiment: string, metric: string): number {
    return this.telemetry.get(`${experiment}\u0000${metric}`) ?? 0;
  }
}

function sameJSON(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export const store = new Store();

export function post(msg: FromFrame, transfer?: Transferable[]) {
  // The app's origin isn't ours to know (we're sandboxed); only it gets these.
  window.parent.postMessage(msg, "*", transfer);
}

let nextId = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

export function request(r: { method: "file"; params: { path: string } }): Promise<FileReply>;
export function request(r: { method: "log"; params: { tail?: number; grep?: string } }): Promise<string[]>;
export function request(r: { method: "setState"; params: { key: string; value: unknown } }): Promise<unknown>;
export function request(r: Extract<FrameRequest, { method: "query" | "catalog" | "events" }>): Promise<unknown>;
export function request(r: Extract<FrameRequest, { method: `plugin.${string}` }>): Promise<unknown>;
export function request(r: FrameRequest): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    post({ t: "request", id, ...r } as FromFrame);
  });
}

export function settle(id: number, result: unknown, error?: string) {
  const w = waiting.get(id);
  if (!w) return;
  waiting.delete(id);
  if (error !== undefined) w.reject(new Error(error));
  else w.resolve(result);
}

let reported = 0;
const seen = new Set<string>();

/** Tells the app (and so the model) about an error, a few at most. */
export function reportError(message: string) {
  if (seen.has(message) || reported >= 20) return;
  seen.add(message);
  reported++;
  post({ t: "error", message });
}
