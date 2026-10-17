import type { Process, ProcessSeries, ProcessWidget } from "@everywhere/protocol";
import { AlertTriangleIcon, OctagonAlertIcon, TableIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatDuration, formatNumber } from "./progress";

/*
 * The charts processes show, as widgets the model declares and as the
 * components dashboards are built from (src/dashboard/api.tsx).
 */

/** The widgets a process shows: charts and tables the model asked for. */
export function ProcessWidgets({ process: p }: { process: Process }) {
  const widgets = p.widgets ?? [];
  return (
    <Grid className="min-h-0 flex-1 overflow-y-auto p-3">
      {widgets.map((w) => (
        <WidgetCard key={w.id} widget={w} />
      ))}
    </Grid>
  );
}

/** Cards in columns at least min px wide; wide cards span the row. */
export function Grid({ min = 288, className, children }: { min?: number; className?: string; children?: ReactNode }) {
  return (
    <div
      className={cn("grid content-start gap-3", className)}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${min}px), 1fr))` }}
    >
      {children}
    </div>
  );
}

export function Card({
  title,
  unit,
  wide,
  actions,
  className,
  children,
}: {
  title?: string;
  unit?: string;
  wide?: boolean;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={cn("grid min-w-0 content-start gap-2 rounded-md border bg-card p-3", wide && "col-span-full", className)}>
      {(title || unit || actions) && (
        <header className="flex min-w-0 items-baseline gap-2 text-xs">
          {title && <h3 className="min-w-0 truncate font-medium">{title}</h3>}
          {unit && <span className="shrink-0 text-muted-foreground">{unit}</span>}
          <span className="flex-1" />
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/** A widget a process declared, in its card. */
export function WidgetCard({ widget: w }: { widget: ProcessWidget }) {
  const [asTable, setAsTable] = useState(false);
  const charted = w.kind === "line" || w.kind === "bar";
  const wide = w.kind === "line" || w.kind === "table";
  const single = w.kind === "line" && w.series?.length === 1 ? w.series[0] : undefined;
  // A gauge or a lone line shows the unit with its value.
  const headUnit = w.kind !== "gauge" && !single;
  return (
    <Card
      title={w.title || w.id}
      unit={headUnit ? w.unit : undefined}
      wide={wide}
      actions={
        <>
          {single && <Latest series={single} unit={w.unit} />}
          {charted && (
          <button
            type="button"
            onClick={() => setAsTable(!asTable)}
            className={cn(
              "shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground",
              asTable && "bg-accent text-foreground",
            )}
            aria-pressed={asTable}
            title={asTable ? "Show the chart" : "Show the data"}
          >
            <TableIcon className="size-3.5" />
          </button>
          )}
        </>
      }
    >
      {asTable && charted ? (
        <DataTable widget={w} />
      ) : w.kind === "line" ? (
        <LineChart series={w.series ?? []} xLabel={w.xLabel} unit={w.unit} title={w.title || w.id} />
      ) : w.kind === "bar" ? (
        <BarChart bars={w.bars ?? []} unit={w.unit} title={w.title || w.id} />
      ) : w.kind === "gauge" ? (
        <Gauge value={w.value} min={w.min} max={w.max} warn={w.warn} critical={w.critical} unit={w.unit} />
      ) : (
        <Table columns={w.columns ?? []} rows={w.rows ?? []} />
      )}
    </Card>
  );
}

function Latest({ series, unit }: { series: ProcessSeries; unit?: string }) {
  const last = series.points[series.points.length - 1];
  if (!last) return null;
  return (
    <span className="shrink-0 tabular-nums">
      {formatNumber(last[1])}
      {unit ? ` ${unit}` : ""}
    </span>
  );
}

export function Empty({ children }: { children?: ReactNode }) {
  return <p className="py-6 text-center text-xs text-muted-foreground">{children ?? "Waiting for data"}</p>;
}

/** The element's width, kept up to date. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export const SERIES_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];
// So lines tell apart without color too (and in monochrome themes).
const SERIES_DASHES = [undefined, "6 3", "1.5 3", "8 3 1.5 3"];

/** Round ticks covering lo to hi. */
function niceTicks(lo: number, hi: number, count: number): number[] {
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const err = raw / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const ticks: number[] = [];
  for (let t = Math.floor(lo / step) * step; t <= hi + step * 0.999; t += step) {
    ticks.push(Number(t.toPrecision(12)));
    if (t >= hi) break;
  }
  return ticks;
}

const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 43200, 86400];

/** Ticks for elapsed seconds, on round durations. */
function timeTicks(lo: number, hi: number, count: number): number[] {
  const step = TIME_STEPS.find((s) => (hi - lo) / s <= count) ?? TIME_STEPS[TIME_STEPS.length - 1]!;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  return ticks;
}

function formatAxis(n: number): string {
  return Math.abs(n) >= 10_000
    ? n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 })
    : formatNumber(n);
}

const LINE_HEIGHT = 160;
const PAD = { top: 8, right: 8, bottom: 18 };

/** Up to 4 series over time (seconds) or over xLabel, with hover and a legend. */
export function LineChart({
  series: given,
  xLabel,
  unit,
  height = LINE_HEIGHT,
  title,
}: {
  series: ProcessSeries[];
  xLabel?: string;
  unit?: string;
  height?: number;
  title?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const series = given.slice(0, SERIES_COLORS.length).filter((s) => s.points.length > 0);
  const all = series.flatMap((s) => s.points);
  const overTime = !xLabel;
  const formatX = (x: number) => (overTime ? formatDuration(x) : `${xLabel} ${formatNumber(x)}`);

  let body = <Empty />;
  if (all.length > 0 && width > 0) {
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const yTicks = niceTicks(Math.min(...ys), Math.max(...ys), 4);
    const [y0, y1] = [yTicks[0]!, yTicks[yTicks.length - 1]!];
    const left = Math.max(...yTicks.map((t) => formatAxis(t).length)) * 6 + 10;
    const plotW = Math.max(1, width - left - PAD.right);
    const plotH = height - PAD.top - PAD.bottom;
    const sx = (x: number) => left + (x1 === x0 ? plotW / 2 : ((x - x0) / (x1 - x0)) * plotW);
    const sy = (y: number) => PAD.top + plotH - ((y - y0) / (y1 - y0 || 1)) * plotH;
    const xTicks = x1 === x0 ? [x0] : overTime ? timeTicks(x0, x1, Math.max(2, Math.floor(plotW / 70))) : niceTicks(x0, x1, Math.max(2, Math.floor(plotW / 70))).filter((t) => t >= x0 && t <= x1);

    // The point of each series nearest the hovered x.
    const nearest = (s: ProcessSeries, x: number) =>
      s.points.reduce((best, p) => (Math.abs(p[0] - x) < Math.abs(best[0] - x) ? p : best));
    const hovered = hover === null ? null : series.map((s) => nearest(s, hover));
    const hoverX = hovered ? nearest({ key: "", points: hovered.filter(Boolean) as [number, number][] }, hover!)[0] : null;

    body = (
      <div className="relative">
        <svg
          width={width}
          height={height}
          className="block touch-pan-y select-none"
          onPointerMove={(e) => {
            const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
            setHover(x0 + ((Math.min(Math.max(px, left), left + plotW) - left) / plotW) * (x1 - x0));
          }}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={`${title ?? "Line chart"}: line chart`}
        >
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={left} x2={left + plotW} y1={sy(t)} y2={sy(t)} stroke="var(--border)" strokeWidth={1} />
              <text x={left - 6} y={sy(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px]">
                {formatAxis(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text
              key={t}
              x={sx(t)}
              y={height - 4}
              // Kept inside the chart at its edges.
              textAnchor={sx(t) > width - 24 ? "end" : sx(t) < left + 12 ? "start" : "middle"}
              className="fill-muted-foreground text-[10px]"
            >
              {overTime ? formatDuration(t) : formatAxis(t)}
            </text>
          ))}
          {series.map((s, i) => {
            const color = SERIES_COLORS[i]!;
            const last = s.points[s.points.length - 1]!;
            return (
              <g key={s.key}>
                {s.points.length > 1 && (
                  <polyline
                    points={s.points.map((p) => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ")}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeDasharray={SERIES_DASHES[i]}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}
                {hover === null && (
                  <circle cx={sx(last[0])} cy={sy(last[1])} r={4} fill={color} stroke="var(--card)" strokeWidth={2} />
                )}
              </g>
            );
          })}
          {hovered && hoverX !== null && (
            <g pointerEvents="none">
              <line x1={sx(hoverX)} x2={sx(hoverX)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--muted-foreground)" strokeWidth={1} />
              {hovered.map((p, i) => (
                <circle key={series[i]!.key} cx={sx(p[0])} cy={sy(p[1])} r={4} fill={SERIES_COLORS[i]} stroke="var(--card)" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
        {hovered && hoverX !== null && (
          <div
            className="pointer-events-none absolute top-1 z-10 grid gap-0.5 rounded-md border bg-popover px-2 py-1 text-[11px] shadow-md"
            style={sx(hoverX) > width / 2 ? { right: width - sx(hoverX) + 8 } : { left: sx(hoverX) + 8 }}
          >
            <span className="text-muted-foreground">{formatX(hoverX)}</span>
            {hovered.map((p, i) => (
              <span key={series[i]!.key} className="flex items-center gap-1.5 whitespace-nowrap">
                {series.length > 1 && <Swatch index={i} />}
                {series.length > 1 && <span className="text-muted-foreground">{seriesName(series[i]!)}</span>}
                <span className="ml-auto tabular-nums">
                  {formatNumber(p[1])}
                  {unit ? ` ${unit}` : ""}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <div ref={ref} className="min-w-0">
        {body}
      </div>
      {series.length > 1 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]" aria-label="Legend">
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <Swatch index={i} />
              <span className="text-muted-foreground">{seriesName(s)}</span>
              <span className="tabular-nums">{formatNumber(s.points[s.points.length - 1]![1])}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const seriesName = (s: ProcessSeries) => s.label || s.key;

/** A short line in the series' color and dash, for legends. */
function Swatch({ index }: { index: number }) {
  return (
    <svg width={16} height={6} className="shrink-0" aria-hidden>
      <line
        x1={1}
        x2={15}
        y1={3}
        y2={3}
        stroke={SERIES_COLORS[index]}
        strokeWidth={2}
        strokeDasharray={SERIES_DASHES[index]}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Horizontal bars from one baseline, the value at each tip. */
export function BarChart({ bars, unit, title }: { bars: { label: string; value: number }[]; unit?: string; title?: string }) {
  if (bars.length === 0) return <Empty />;
  const lo = Math.min(0, ...bars.map((b) => b.value));
  const hi = Math.max(0, ...bars.map((b) => b.value));
  const span = hi - lo || 1;
  const zero = (-lo / span) * 100;
  return (
    <ul className="grid max-h-72 gap-1 overflow-y-auto text-xs" aria-label={`${title ?? "Bar chart"}: bar chart`}>
      {bars.map((b) => {
        const size = (Math.abs(b.value) / span) * 100;
        const negative = b.value < 0;
        return (
          <li
            key={b.label}
            className="grid grid-cols-[minmax(0,35%)_1fr_auto] items-center gap-2 rounded-sm px-1 hover:bg-accent/40"
            title={`${b.label}: ${formatNumber(b.value)}${unit ? ` ${unit}` : ""}`}
          >
            <span className="truncate text-muted-foreground">{b.label}</span>
            <span className="relative h-3">
              <span
                className={cn("absolute inset-y-0 bg-chart-1", negative ? "rounded-l-[4px]" : "rounded-r-[4px]")}
                style={negative ? { right: `${100 - zero}%`, width: `${size}%` } : { left: `${zero}%`, width: `${size}%` }}
              />
            </span>
            <span className="text-right tabular-nums">{formatNumber(b.value)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export interface GaugeProps {
  value?: number;
  min?: number;
  max?: number;
  warn?: number;
  critical?: number;
  unit?: string;
}

/** Where a value stands against the gauge's thresholds. */
export function level(w: Pick<GaugeProps, "warn" | "critical">, v: number): "ok" | "warn" | "critical" {
  const lowIsBad = w.warn !== undefined && w.critical !== undefined && w.critical < w.warn;
  const past = (t?: number) => t !== undefined && (lowIsBad ? v <= t : v >= t);
  return past(w.critical) ? "critical" : past(w.warn) ? "warn" : "ok";
}

/** One value as a meter between min and max, colored by its thresholds. */
export function Gauge(w: GaugeProps) {
  if (w.value === undefined) return <Empty />;
  const min = w.min ?? 0;
  const max = w.max ?? Math.max(w.value, 1);
  const at = (v: number) => Math.min(100, Math.max(0, ((v - min) / (max - min || 1)) * 100));
  const lv = level(w, w.value);
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-medium tabular-nums">{formatNumber(w.value)}</span>
        {w.unit && <span className="text-xs text-muted-foreground">{w.unit}</span>}
        <span className="text-xs text-muted-foreground tabular-nums">/ {formatNumber(max)}</span>
        {lv !== "ok" && (
          <span className={cn("ml-auto flex items-center gap-1 text-xs", lv === "critical" ? "text-destructive" : "text-warn")}>
            {lv === "critical" ? <OctagonAlertIcon className="size-3.5" /> : <AlertTriangleIcon className="size-3.5" />}
            {lv === "critical" ? "Critical" : "Warning"}
          </span>
        )}
      </div>
      <div
        className="relative h-2 rounded-full bg-muted"
        role="meter"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={w.value}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            lv === "critical" ? "bg-destructive" : lv === "warn" ? "bg-warn" : "bg-chart-1",
          )}
          style={{ width: `${at(w.value)}%` }}
        />
        {[w.warn, w.critical].map(
          (t, i) =>
            t !== undefined && (
              <span
                key={i}
                className="absolute -inset-y-0.5 w-px bg-foreground/50"
                style={{ left: `${at(t)}%` }}
                title={`${i === 0 ? "Warning" : "Critical"} at ${formatNumber(t)}`}
              />
            ),
        )}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{formatNumber(min)}</span>
        <span>{formatNumber(max)}</span>
      </div>
    </div>
  );
}

export function Table({ columns, rows }: { columns: string[]; rows: (string | number | boolean | null)[][] }) {
  if (rows.length === 0) return <Empty />;
  const numeric = columns.map((_, i) => rows.every((r) => r[i] === undefined || typeof r[i] === "number"));
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-card">
          <tr>
            {columns.map((c, i) => (
              <th key={i} className={cn("border-b px-2 py-1 font-medium text-muted-foreground", numeric[i] ? "text-right" : "text-left")}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="not-last:border-b hover:bg-accent/30">
              {columns.map((_, j) => (
                <td key={j} className={cn("px-2 py-1", numeric[j] ? "text-right tabular-nums" : "max-w-64 truncate")}>
                  {typeof r[j] === "number" ? formatNumber(r[j]) : String(r[j] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A chart's numbers as a table, for reading exact values. */
function DataTable({ widget: w }: { widget: ProcessWidget }) {
  if (w.kind === "bar") {
    return <Table columns={["", w.unit || "value"]} rows={(w.bars ?? []).map((b) => [b.label, b.value])} />;
  }
  const series = w.series ?? [];
  const x = w.xLabel || "time";
  const rows = series.flatMap((s) =>
    s.points.map((p) => [w.xLabel ? p[0] : formatDuration(p[0]), ...(series.length > 1 ? [seriesName(s)] : []), p[1]]),
  );
  return <Table columns={[x, ...(series.length > 1 ? ["series"] : []), w.unit || "value"]} rows={rows.reverse()} />;
}
