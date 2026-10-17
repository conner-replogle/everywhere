/**
 * The everywhere dashboard API: what `import { … } from "everywhere"` gives
 * a dashboard in .everywhere/dashboards/<name>/index.tsx.
 *
 * A dashboard belongs to a process (process_start's dashboard) and draws what
 * it reported to its project's telemetry: the process gets and crunches the
 * data and logs it, the dashboard asks for what it shows. It runs in a
 * sandboxed frame with no network; everything comes through these hooks.
 *
 * React is there too: import { useState } from "react". Tailwind classes work,
 * with the app's colors (bg-card, text-muted-foreground, border, text-primary,
 * bg-chart-1 … bg-chart-4, text-live, text-warn, text-destructive).
 *
 * This file is written by the everywhere daemon; editing it does nothing.
 */
declare module "everywhere" {
  type Node = any;

  // --- the process ---------------------------------------------------------

  export interface Process {
    id: string;
    name: string;
    command?: string;
    cwd?: string;
    status: "running" | "exited" | "stopped" | "failed" | "lost" | "done";
    exitCode?: number;
    /** Unix ms. */
    startedAt: number;
    endedAt?: number;
    checkpoints: { label: string; reachedAt?: number }[];
    stats: { key: string; label?: string; unit?: string; value: number; total?: number; rate?: number; eta?: number }[];
    statusText?: string;
    urls?: string[];
    lastLine?: string;
    /** What it reports as: a run of an experiment. */
    experiment?: string;
    run?: string;
    /** Widgets it declared; show one with <Widget id>. */
    widgets?: { id: string; kind: string; title?: string }[];
  }

  /** The dashboard's process, kept up to date. */
  export function useProcess(): Process;

  // --- telemetry: what processes report, asked for as charts need it ----------

  /**
   * A metric, bucketed on the device to about `points` points per series, so
   * a chart gets what it draws and no more. Unless where says otherwise,
   * it's the dashboard's process's experiment, every run of it.
   */
  export interface Query {
    metric: string;
    /** By label (experiment, run, or any label it was logged with); a list matches any of its values. */
    where?: Record<string, string[]>;
    /** A series per value of these labels. Default ["run"]. */
    groupBy?: string[];
    /** "step", or "time" (seconds since its run started). Default: step if it was logged with steps. */
    x?: "step" | "time";
    /** Only x in this range: zoom in by asking again. */
    from?: number;
    to?: number;
    /** About the chart's width in points. Default 400, at most 2000. */
    points?: number;
  }

  export interface QueryResult {
    x: "step" | "time";
    /** points are [x, mean of the bucket]; min and max the bucket's extremes, in step with them. */
    series: { labels: Record<string, string>; points: [number, number][]; min: number[]; max: number[] }[];
  }

  /** A query's answer, asked again when its metric gets new data. Pass null to skip. */
  export function useQuery(query: Query | null): { data?: QueryResult; loading: boolean; error?: string };

  export interface RunInfo {
    experiment: string;
    run: string;
    startedAt: number;
    endedAt?: number;
    /** running, exited, exited 3, stopped, failed, done… */
    status: string;
  }

  /** An experiment's runs and metrics (default: the process's experiment), kept current. */
  export function useCatalog(experiment?: string): {
    data?: { runs: RunInfo[]; metrics: { name: string; labels: Record<string, string[]>; steps: boolean }[] };
    loading: boolean;
    error?: string;
  };

  export interface TelemetryEvent<T = unknown> {
    id: number;
    run: string;
    /** Unix ms. */
    ts: number;
    kind: string;
    data: T;
  }

  /** An uploaded file's event data (kind "attachment"): show it with <Image path> or <Video path>. */
  export interface Attachment {
    path: string;
    name: string;
    type: string;
    size: number;
    step?: number;
    caption?: string;
  }

  /**
   * Events the runs reported (POST /event, /attach; OTLP logs are kind
   * "log"), newest first, kept current. Default: the process's experiment,
   * every run, every kind, the last 50.
   */
  export function useTelemetryEvents<T = unknown>(options?: {
    kind?: string;
    runs?: string[];
    experiment?: string;
    limit?: number;
  }): { events: TelemetryEvent<T>[]; loading: boolean; error?: string };

  export interface FileState {
    /** An object URL for <img>, <video>, fetch() … */
    url?: string;
    /** MIME type, from the extension. */
    type?: string;
    size?: number;
    loading: boolean;
    error?: string;
  }

  /**
   * A file from the device (relative to the process's directory or the
   * project, as an attachment's path is; inside the project), up to 50 MB. Read again when refresh changes: pass
   * the event that named the file, or its mtime.
   */
  export function useFile(path: string | undefined, options?: { refresh?: unknown }): FileState;
  export function useText(path: string | undefined, options?: { refresh?: unknown }): { text?: string; loading: boolean; error?: string };
  export function useJSON<T = unknown>(path: string | undefined, options?: { refresh?: unknown }): { data?: T; loading: boolean; error?: string };

  /**
   * State the dashboard keeps, like useState but stored in the project's
   * telemetry, so it's the same after a reload and on every device, and
   * survives new runs. Use it for
   * anything the user picks: a tab, a filter, a selected item, a zoom.
   * useState is for what may be forgotten (hover, an open menu). Values are
   * JSON, up to 16 KB each, 64 keys; key is letters, digits, - and _.
   */
  export function useDashboardState<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void];

  /** The process's output as plain text, live. Default tail 200, at most 2000. */
  export function useLog(options?: { tail?: number; grep?: string }): { lines: string[]; loading: boolean; error?: string };

  // --- layout --------------------------------------------------------------

  /** Cards in columns at least min px wide (default 288); wide cards span the row. */
  export function Grid(props: { min?: number; children?: Node }): Node;
  export function Card(props: { title?: string; unit?: string; wide?: boolean; actions?: Node; className?: string; children?: Node }): Node;
  /** A headline number. status colors it with an icon (and says so). */
  export function Stat(props: {
    label: string;
    value: number | string | undefined;
    unit?: string;
    hint?: string;
    status?: "ok" | "warn" | "critical";
  }): Node;
  /** "Waiting for data", or what you say. */
  export function Empty(props: { children?: Node }): Node;

  // --- charts --------------------------------------------------------------

  export interface Series {
    key: string;
    label?: string;
    /** [x, y], ascending x. */
    points: [number, number][];
  }

  /**
   * Up to 4 series, with hover, legend and the theme's colors. Without
   * xLabel, x is seconds (shown as durations); with one, plain numbers.
   */
  export function LineChart(props: { series: Series[]; xLabel?: string; unit?: string; height?: number }): Node;
  /** Horizontal bars from a zero baseline, value at the tip. */
  export function BarChart(props: { bars: { label: string; value: number }[]; unit?: string }): Node;
  /** One value between min (0) and max; past warn or critical it says so. critical < warn means low is bad. */
  export function Gauge(props: { value?: number; min?: number; max?: number; warn?: number; critical?: number; unit?: string }): Node;
  /** Numbers right-aligned. */
  export function Table(props: { columns: string[]; rows: (string | number | boolean | null)[][] }): Node;
  /** A widget the process declared, drawn as in the Charts view. */
  export function Widget(props: { id: string }): Node;

  // --- media ---------------------------------------------------------------

  /** An image file from the device (see useFile). */
  export function Image(props: { path: string; alt?: string; refresh?: unknown; className?: string }): Node;
  /** A video file from the device (see useFile). */
  export function Video(props: {
    path: string;
    refresh?: unknown;
    className?: string;
    autoPlay?: boolean;
    loop?: boolean;
    muted?: boolean;
    controls?: boolean;
  }): Node;

  // --- theme ---------------------------------------------------------------

  /**
   * The app's colors as CSS values (var(--…)), for style and SVG. series is
   * the 4 chart colors: series i is always the same thing, never reused for
   * status. live/warn/destructive are for good/warning/critical, with a word
   * or icon, never alone.
   */
  export const theme: {
    series: string[];
    background: string;
    foreground: string;
    card: string;
    muted: string;
    mutedForeground: string;
    border: string;
    primary: string;
    live: string;
    warn: string;
    destructive: string;
  };

  /**
   * The same colors resolved to hex, for canvas and WebGL. Re-renders when
   * the user changes theme.
   */
  export function useThemeColors(): {
    dark: boolean;
    series: string[];
    background: string;
    foreground: string;
    card: string;
    muted: string;
    mutedForeground: string;
    border: string;
    primary: string;
    live: string;
    warn: string;
    destructive: string;
  };

  // --- helpers -------------------------------------------------------------

  /** 1,234.5; 0.00123. */
  export function formatNumber(n: number): string;
  /** 8s, 1m08s, 2h05m. */
  export function formatDuration(seconds: number): string;
  /** Joins class names, later Tailwind classes winning. */
  export function cn(...classes: (string | false | null | undefined)[]): string;
}
