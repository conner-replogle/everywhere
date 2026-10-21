import type * as Everywhere from "everywhere";
import { useKV, usePlugin } from "./plugin-api";
import { AlertTriangleIcon, CheckIcon, OctagonAlertIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { formatDuration, formatNumber } from "@/components/processes/progress";
import {
  BarChart,
  Card,
  Empty,
  Gauge,
  Grid,
  LineChart,
  SERIES_COLORS,
  Table,
  WidgetCard,
  type XRange,
} from "@/components/processes/widgets";
import { useDebounced, ZOOM_ASK_MS } from "@/lib/telemetry";
import { cn } from "@/lib/utils";
import { reportError, request, store, UNSET } from "./frame";

/*
 * The "everywhere" module dashboards import: the app's charts, plus hooks
 * that get the dashboard's process's data through the bridge. Its shape is
 * daemon/internal/dashboard/everywhere.d.ts, which the agent reads; the
 * check at the bottom keeps the two in step.
 */

function useProcess(): Everywhere.Process {
  const p = useSyncExternalStore(store.subscribe, () => store.process);
  if (!p) throw new Error("useProcess before the dashboard started");
  return p as Everywhere.Process;
}

/** Asking the device again is at most this often, however often data comes. */
const ASK_EVERY_MS = 1000;

/**
 * Asks (with ask, whenever key changes, and again, at most every
 * ASK_EVERY_MS, when version does), keeping the last answer meanwhile.
 */
function useAsk<T>(ask: (() => Promise<T>) | null, key: string, version: number) {
  const [state, setState] = useState<{ data?: T; loading: boolean; error?: string }>({ loading: !!ask });
  const askRef = useRef(ask);
  askRef.current = ask;
  const last = useRef(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  // A new question is asked at once; new data for the same one waits its turn.
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    const fn = askRef.current;
    if (!fn) {
      setState({ loading: false });
      return;
    }
    const fresh = lastKey.current !== key;
    lastKey.current = key;
    const wait = fresh ? 0 : Math.max(0, last.current + ASK_EVERY_MS - Date.now());
    if (fresh) setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      last.current = Date.now();
      fn().then(
        (data) => mounted.current && lastKey.current === key && setState({ data, loading: false }),
        (e: Error) => mounted.current && setState((s) => ({ ...s, loading: false, error: e.message })),
      );
    }, wait);
    return () => clearTimeout(timer);
  }, [key, version]);
  return state;
}

/** A metric from telemetry as a zoomable chart that asks for the zoomed range in detail. */
function MetricChart({
  metric,
  where,
  groupBy,
  x,
  unit,
  height,
  zoom: zoomProp,
  onZoom,
}: {
  metric: string;
  where?: Record<string, string[]>;
  groupBy?: string[];
  x?: "step" | "time";
  unit?: string;
  height?: number;
  zoom?: XRange | null;
  onZoom?: (range: XRange | null) => void;
}) {
  const [own, setOwn] = useState<XRange | null>(null);
  const zoom = onZoom ? (zoomProp ?? null) : own;
  const asked = useDebounced(zoom, ZOOM_ASK_MS);
  const res = useQuery({
    metric,
    where,
    groupBy,
    x,
    points: 600,
    ...(asked ? { from: asked[0], to: asked[1] } : {}),
  });
  if (res.error) return <Empty>{res.error}</Empty>;
  const keys = groupBy ?? ["run"];
  const series = (res.data?.series ?? []).map((s) => ({
    key: keys.map((k) => s.labels[k] ?? "").join(" · ") || metric,
    points: s.points,
  }));
  return (
    <LineChart
      series={series}
      xLabel={(res.data?.x ?? x) === "step" ? "step" : undefined}
      unit={unit}
      height={height}
      title={metric}
      zoom={zoom}
      onZoom={onZoom ?? setOwn}
    />
  );
}

function useQuery(query: Everywhere.Query | null) {
  const p = useSyncExternalStore(store.subscribe, () => store.process);
  const full = query && {
    ...query,
    where: { ...(p?.experiment ? { experiment: [p.experiment] } : {}), ...query.where },
  };
  const experiment = full?.where.experiment?.[0] ?? "";
  const version = useSyncExternalStore(store.subscribe, () =>
    full ? store.telemetryVersion(experiment, full.metric) : 0,
  );
  const key = JSON.stringify(full);
  return useAsk(
    full ? () => request({ method: "query", params: { query: full } }) as Promise<Everywhere.QueryResult> : null,
    key,
    version,
  );
}

type CatalogData = NonNullable<ReturnType<typeof Everywhere.useCatalog>["data"]>;

function useCatalog(experiment?: string) {
  const p = useSyncExternalStore(store.subscribe, () => store.process);
  const exp = experiment ?? p?.experiment ?? "";
  const version = useSyncExternalStore(store.subscribe, () => store.telemetryVersion(exp, "*"));
  return useAsk(
    exp ? () => request({ method: "catalog", params: { experiment: exp } }) as Promise<CatalogData> : null,
    exp,
    version,
  );
}

function useTelemetryEvents<T = unknown>(options?: { kind?: string; runs?: string[]; experiment?: string; limit?: number }) {
  const p = useSyncExternalStore(store.subscribe, () => store.process);
  const exp = options?.experiment ?? p?.experiment ?? "";
  const version = useSyncExternalStore(store.subscribe, () => store.telemetryVersion(exp, "*"));
  const params = { ...options, experiment: exp, limit: options?.limit ?? 50 };
  const res = useAsk(
    exp ? () => request({ method: "events", params }) as Promise<Everywhere.TelemetryEvent<T>[]> : null,
    JSON.stringify(params),
    version,
  );
  return { events: res.data ?? [], loading: res.loading, error: res.error };
}

interface Bytes {
  bytes?: ArrayBuffer;
  type?: string;
  size?: number;
  loading: boolean;
  error?: string;
}

/** A refresh value as a key: objects compare by content. */
function refreshKey(refresh: unknown): string {
  try {
    return JSON.stringify(refresh) ?? "";
  } catch {
    return String(refresh);
  }
}

function useBytes(path: string | undefined, refresh: unknown): Bytes {
  const key = refreshKey(refresh);
  const [state, setState] = useState<Bytes>({ loading: !!path });
  useEffect(() => {
    if (!path) {
      setState({ loading: false });
      return;
    }
    let live = true;
    // Keep showing what we have until the new read lands.
    setState((s) => ({ ...s, loading: true }));
    request({ method: "file", params: { path } }).then(
      (r) => live && setState({ bytes: r.bytes, type: r.type, size: r.size, loading: false }),
      (e: Error) => live && setState({ loading: false, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [path, key]);
  return state;
}

function useFile(path: string | undefined, options?: { refresh?: unknown }): Everywhere.FileState {
  const b = useBytes(path, options?.refresh);
  const url = useMemo(() => (b.bytes ? URL.createObjectURL(new Blob([b.bytes], { type: b.type })) : undefined), [b.bytes, b.type]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return { url, type: b.type, size: b.size, loading: b.loading, error: b.error };
}

function useText(path: string | undefined, options?: { refresh?: unknown }) {
  const b = useBytes(path, options?.refresh);
  const text = useMemo(() => (b.bytes ? new TextDecoder().decode(b.bytes) : undefined), [b.bytes]);
  return { text, loading: b.loading, error: b.error };
}

function useJSON<T = unknown>(path: string | undefined, options?: { refresh?: unknown }) {
  const t = useText(path, options);
  return useMemo(() => {
    if (t.text === undefined) return { loading: t.loading, error: t.error };
    try {
      return { data: JSON.parse(t.text) as T, loading: t.loading };
    } catch (e) {
      return { loading: false, error: `${path}: ${(e as Error).message}` };
    }
  }, [t.text, t.loading, t.error, path]);
}

function useDashboardState<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const held = useSyncExternalStore(store.subscribe, () => store.stateValue(key));
  const value = (held === UNSET ? initial : held) as T;
  const latest = useRef(value);
  latest.current = value;
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const v = typeof next === "function" ? (next as (prev: T) => T)(latest.current) : next;
      latest.current = v;
      store.setPendingState(key, v);
      request({ method: "setState", params: { key, value: v ?? null } }).catch((e: Error) => {
        store.dropPendingState(key);
        reportError(`useDashboardState(${JSON.stringify(key)}): ${e.message}`);
      });
    },
    [key],
  );
  return [value, set];
}

const LOG_EVERY_MS = 1000;

function useLog(options?: { tail?: number; grep?: string }) {
  const p = useSyncExternalStore(store.subscribe, () => store.process);
  const [state, setState] = useState<{ lines: string[]; loading: boolean; error?: string }>({ lines: [], loading: true });
  const tail = options?.tail;
  const grep = options?.grep;
  // A new process view means it may have printed more.
  const tick = p ? `${p.status}:${p.lastLine ?? ""}:${p.endedAt ?? ""}` : "";
  const lastRead = useRef(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    // At most a read a second, however often the process changes; a reply
    // still lands if the process changed again meanwhile.
    const wait = Math.max(0, lastRead.current + LOG_EVERY_MS - Date.now());
    const timer = setTimeout(() => {
      lastRead.current = Date.now();
      request({ method: "log", params: { tail, grep } }).then(
        (lines) => mounted.current && setState({ lines, loading: false }),
        (e: Error) => mounted.current && setState((s) => ({ ...s, loading: false, error: e.message })),
      );
    }, wait);
    return () => clearTimeout(timer);
  }, [tail, grep, tick]);
  return state;
}

function Stat({
  label,
  value,
  unit,
  hint,
  status,
}: {
  label: string;
  value: number | string | undefined;
  unit?: string;
  hint?: string;
  status?: "ok" | "warn" | "critical";
}) {
  const Icon = status === "critical" ? OctagonAlertIcon : status === "warn" ? AlertTriangleIcon : status === "ok" ? CheckIcon : null;
  return (
    <section className="grid min-w-0 content-start gap-1 rounded-md border bg-card p-3">
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-2xl font-medium">
          {value === undefined ? "—" : typeof value === "number" ? formatNumber(value) : value}
        </span>
        {unit && value !== undefined && <span className="text-xs text-muted-foreground">{unit}</span>}
        {Icon && (
          <span
            className={cn(
              "ml-auto flex shrink-0 items-center gap-1 text-xs",
              status === "critical" ? "text-destructive" : status === "warn" ? "text-warn" : "text-live",
            )}
          >
            <Icon className="size-3.5" />
            {status === "critical" ? "Critical" : status === "warn" ? "Warning" : "OK"}
          </span>
        )}
      </div>
      {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
    </section>
  );
}

function Media({ state, children }: { state: Everywhere.FileState; children: (url: string) => ReactNode }) {
  if (state.url) return children(state.url);
  return <Empty>{state.error ?? (state.loading ? "Loading…" : "No file")}</Empty>;
}

function Image({ path, alt, refresh, className }: { path: string; alt?: string; refresh?: unknown; className?: string }) {
  const f = useFile(path, { refresh });
  return <Media state={f}>{(url) => <img src={url} alt={alt ?? path} className={cn("max-w-full rounded-md", className)} />}</Media>;
}

function Video({
  path,
  refresh,
  className,
  autoPlay,
  loop,
  muted,
  controls = true,
}: {
  path: string;
  refresh?: unknown;
  className?: string;
  autoPlay?: boolean;
  loop?: boolean;
  muted?: boolean;
  controls?: boolean;
}) {
  const f = useFile(path, { refresh });
  return (
    <Media state={f}>
      {(url) => (
        <video
          src={url}
          className={cn("max-w-full rounded-md", className)}
          autoPlay={autoPlay}
          loop={loop}
          muted={muted ?? autoPlay}
          controls={controls}
          playsInline
        />
      )}
    </Media>
  );
}

function Widget({ id }: { id: string }) {
  const p = useSyncExternalStore(store.subscribe, () => store.process);
  const w = p?.widgets?.find((x) => x.id === id);
  if (!w) return <Empty>No widget {id}</Empty>;
  return <WidgetCard widget={w} />;
}

const theme = {
  series: SERIES_COLORS,
  background: "var(--background)",
  foreground: "var(--foreground)",
  card: "var(--card)",
  muted: "var(--muted)",
  mutedForeground: "var(--muted-foreground)",
  border: "var(--border)",
  primary: "var(--primary)",
  live: "var(--live)",
  warn: "var(--warn)",
  destructive: "var(--destructive)",
};

function useThemeColors() {
  const version = useSyncExternalStore(store.subscribe, () => store.themeVersion);
  return useMemo(() => {
    const v = store.theme.vars;
    const get = (name: string) => v[name] ?? "";
    return {
      dark: store.theme.dark,
      series: [1, 2, 3, 4].map((i) => get(`--chart-${i}`)),
      background: get("--background"),
      foreground: get("--foreground"),
      card: get("--card"),
      muted: get("--muted"),
      mutedForeground: get("--muted-foreground"),
      border: get("--border"),
      primary: get("--primary"),
      live: get("--live"),
      warn: get("--warn"),
      destructive: get("--destructive"),
    };
    // version is what changes when the theme does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
}

function cnJoin(...classes: (string | false | null | undefined)[]) {
  return cn(...classes);
}

export const api = {
  useProcess,
  useQuery,
  useCatalog,
  useTelemetryEvents,
  useFile,
  useText,
  useJSON,
  useLog,
  useDashboardState,
  Grid,
  Card,
  Stat,
  Empty,
  LineChart,
  MetricChart,
  BarChart,
  Gauge,
  Table,
  Widget,
  Image,
  Video,
  theme,
  useThemeColors,
  formatNumber,
  formatDuration,
  cn: cnJoin,
  usePlugin,
  useKV,
} satisfies typeof Everywhere;
