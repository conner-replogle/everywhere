import type { Process, ProcessSeries, ProcessWidget } from "@everywhere/protocol";
import { AlertTriangleIcon, OctagonAlertIcon, TableIcon } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
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

/** An x range a chart shows: [from, to]. */
export type XRange = [number, number];

/** Brush drags shorter than this many px are clicks, not zooms. */
const MIN_BRUSH_PX = 6;

/**
 * Up to 4 series over time (seconds) or over xLabel, with hover, a legend
 * that hides and shows series, and zoom: drag across it (or pinch, or
 * ctrl+scroll / pinch a trackpad) to zoom in, double-click to zoom out,
 * drag with one finger to pan when zoomed. Zoom is the chart's own unless
 * zoom and onZoom are given: then whoever owns it can share it between charts
 * or ask the device for that range in more detail.
 */
export function LineChart({
  series: given,
  xLabel,
  unit,
  height = LINE_HEIGHT,
  title,
  zoom: zoomProp,
  onZoom,
}: {
  series: ProcessSeries[];
  xLabel?: string;
  unit?: string;
  height?: number;
  title?: string;
  zoom?: XRange | null;
  onZoom?: (range: XRange | null) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [ownZoom, setOwnZoom] = useState<XRange | null>(null);
  const zoom = onZoom ? (zoomProp ?? null) : ownZoom;
  const setZoom = onZoom ?? setOwnZoom;
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  // A drag across the plot (from, to, in data x), and touches for pinch/pan.
  const [brush, setBrush] = useState<XRange | null>(null);
  const touches = useRef(new Map<number, number>());
  // The wheel handler, as of the last render: React's onWheel is passive, so
  // it couldn't stop the page zooming too.
  const wheelRef = useRef<((e: WheelEvent, el: Element) => void) | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const svg = el.querySelector("svg");
      if (svg && wheelRef.current) wheelRef.current(e, svg);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
  const gesture = useRef<{ range: XRange; dist?: number; mid?: number; x?: number } | null>(null);

  // Colors follow a series' place in the list, whatever is hidden or empty.
  const indexed = given.slice(0, SERIES_COLORS.length).map((s, i) => ({ s, i }));
  const visible = indexed.filter(({ s }) => s.points.length > 0 && !hidden.has(s.key));
  const overTime = !xLabel;
  const formatX = (x: number) => (overTime ? formatDuration(x) : `${xLabel} ${formatNumber(x)}`);

  const allX = indexed.flatMap(({ s }) => s.points.map((p) => p[0]));
  const dataX: XRange | null = allX.length ? [Math.min(...allX), Math.max(...allX)] : null;
  const [x0, x1] = zoom ?? dataX ?? [0, 1];
  // In view, plus a point either side so lines run to the edges.
  const inView = (pts: [number, number][]) => {
    let a = 0;
    while (a < pts.length - 1 && pts[a + 1]![0] < x0) a++;
    let b = pts.length - 1;
    while (b > 0 && pts[b - 1]![0] > x1) b--;
    return pts.slice(a, b + 1);
  };
  const shown = visible.map(({ s, i }) => ({ s: { ...s, points: inView(s.points) }, i })).filter(({ s }) => s.points.length > 0);
  const ys = shown.flatMap(({ s }) => s.points.filter((p) => p[0] >= x0 && p[0] <= x1).map((p) => p[1]));

  let body = <Empty />;
  if (dataX && width > 0) {
    const yTicks = ys.length ? niceTicks(Math.min(...ys), Math.max(...ys), 4) : niceTicks(0, 1, 4);
    const [y0, y1] = [yTicks[0]!, yTicks[yTicks.length - 1]!];
    const left = Math.max(...yTicks.map((t) => formatAxis(t).length)) * 6 + 10;
    const plotW = Math.max(1, width - left - PAD.right);
    const plotH = height - PAD.top - PAD.bottom;
    const span = x1 - x0;
    const sx = (x: number) => left + (span === 0 ? plotW / 2 : ((x - x0) / span) * plotW);
    const sy = (y: number) => PAD.top + plotH - ((y - y0) / (y1 - y0 || 1)) * plotH;
    const toX = (clientX: number, el: Element) => {
      const px = clientX - el.getBoundingClientRect().left;
      return x0 + ((Math.min(Math.max(px, left), left + plotW) - left) / plotW) * span;
    };
    const ticks = Math.max(2, Math.floor(plotW / 70));
    const xTicks = span === 0 ? [x0] : overTime ? timeTicks(x0, x1, ticks) : niceTicks(x0, x1, ticks).filter((t) => t >= x0 && t <= x1);

    // Zooming in no further than a ten-thousandth of the data's range.
    const minSpan = Math.max((dataX[1] - dataX[0]) / 10_000, 1e-9);
    const zoomTo = (a: number, b: number) => {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (hi - lo < minSpan) {
        const mid = (lo + hi) / 2;
        return setZoom([mid - minSpan / 2, mid + minSpan / 2]);
      }
      // Zoomed out past the data is just the data.
      if (lo <= dataX[0] && hi >= dataX[1] && !onZoom) return setZoom(null);
      setZoom([lo, hi]);
    };
    const scaleAround = (range: XRange, at: number, factor: number) =>
      zoomTo(at - (at - range[0]) * factor, at + (range[1] - at) * factor);

    const nearest = (pts: [number, number][], x: number) =>
      pts.reduce((best, p) => (Math.abs(p[0] - x) < Math.abs(best[0] - x) ? p : best));
    const hovered = hover === null || brush ? null : shown.map(({ s }) => nearest(s.points, hover));
    const hoverX = hovered && hovered.length ? nearest(hovered, hover!)[0] : null;
    const clipId = `clip-${title ?? "chart"}`.replace(/[^\w-]/g, "_");
    // A trackpad pinch (or ctrl+wheel) zooms; plain scrolling scrolls the page.
    wheelRef.current = (e: WheelEvent, el: Element) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      scaleAround([x0, x1], toX(e.clientX, el), Math.exp(e.deltaY * 0.01));
    };

    body = (
      <div className="relative">
        <svg
          width={width}
          height={height}
          // Not zoomed: a finger scrolls the page. Zoomed: it pans the chart.
          className={cn("block select-none", zoom ? "touch-none" : "touch-pan-y", !brush && "cursor-crosshair")}
          onPointerDown={(e) => {
            const x = toX(e.clientX, e.currentTarget);
            if (e.pointerType === "touch") {
              touches.current.set(e.pointerId, e.clientX);
              const pts = [...touches.current.values()];
              gesture.current =
                pts.length === 2
                  ? { range: [x0, x1], dist: Math.abs(pts[0]! - pts[1]!), mid: toX((pts[0]! + pts[1]!) / 2, e.currentTarget) }
                  : { range: [x0, x1], x };
              return;
            }
            if (e.button !== 0) return;
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // No such pointer (a synthetic event): the drag still works inside the chart.
            }
            setBrush([x, x]);
          }}
          onPointerMove={(e) => {
            const x = toX(e.clientX, e.currentTarget);
            if (e.pointerType === "touch" && touches.current.has(e.pointerId)) {
              touches.current.set(e.pointerId, e.clientX);
              const g = gesture.current;
              const pts = [...touches.current.values()];
              if (g && pts.length === 2 && g.dist && g.mid !== undefined) {
                const dist = Math.abs(pts[0]! - pts[1]!);
                if (dist > 10) scaleAround(g.range, g.mid, g.dist / dist);
              } else if (g && pts.length === 1 && zoom && g.x !== undefined) {
                // Pan: the point first touched stays under the finger.
                const w = g.range[1] - g.range[0];
                const from = g.x - ((x - x0) / span) * w;
                zoomTo(from, from + w);
              }
              return;
            }
            if (brush) setBrush([brush[0], x]);
            else setHover(x);
          }}
          onPointerUp={(e) => {
            if (e.pointerType === "touch") {
              touches.current.delete(e.pointerId);
              gesture.current = touches.current.size === 1 ? { range: [x0, x1], x: toX([...touches.current.values()][0]!, e.currentTarget) } : null;
              return;
            }
            if (brush && Math.abs(sx(brush[1]) - sx(brush[0])) >= MIN_BRUSH_PX) zoomTo(brush[0], brush[1]);
            setBrush(null);
          }}
          onPointerCancel={(e) => {
            touches.current.delete(e.pointerId);
            gesture.current = null;
            setBrush(null);
          }}
          onPointerLeave={() => setHover(null)}
          onDoubleClick={() => setZoom(null)}
          role="img"
          aria-label={`${title ?? "Line chart"}: line chart${zoom ? `, zoomed to ${formatX(x0)}–${formatX(x1)}` : ""}`}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={left} y={0} width={plotW} height={height} />
            </clipPath>
          </defs>
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
          <g clipPath={`url(#${clipId})`}>
            {shown.map(({ s, i }) => {
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
                  {hover === null && !brush && last[0] <= x1 && (
                    <circle cx={sx(last[0])} cy={sy(last[1])} r={4} fill={color} stroke="var(--card)" strokeWidth={2} />
                  )}
                </g>
              );
            })}
          </g>
          {brush && (
            <rect
              x={Math.min(sx(brush[0]), sx(brush[1]))}
              y={PAD.top}
              width={Math.abs(sx(brush[1]) - sx(brush[0]))}
              height={plotH}
              fill="var(--primary)"
              fillOpacity={0.12}
              stroke="var(--primary)"
              strokeOpacity={0.5}
              pointerEvents="none"
            />
          )}
          {hovered && hoverX !== null && (
            <g pointerEvents="none">
              <line x1={sx(hoverX)} x2={sx(hoverX)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--muted-foreground)" strokeWidth={1} />
              {hovered.map((p, k) => (
                <circle key={shown[k]!.s.key} cx={sx(p[0])} cy={sy(p[1])} r={4} fill={SERIES_COLORS[shown[k]!.i]} stroke="var(--card)" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
        {zoom && (
          <button
            type="button"
            onClick={() => setZoom(null)}
            className="absolute top-0 right-1 rounded border bg-popover px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm hover:text-foreground"
            title="Show the whole range (or double-click the chart)"
          >
            Reset zoom
          </button>
        )}
        {hovered && hoverX !== null && (
          <div
            className="pointer-events-none absolute top-1 z-10 grid gap-0.5 rounded-md border bg-popover px-2 py-1 text-[11px] shadow-md"
            style={sx(hoverX) > width / 2 ? { right: width - sx(hoverX) + 8 } : { left: sx(hoverX) + 8 }}
          >
            <span className="text-muted-foreground">{formatX(hoverX)}</span>
            {hovered.map((p, k) => (
              <span key={shown[k]!.s.key} className="flex items-center gap-1.5 whitespace-nowrap">
                {indexed.length > 1 && <Swatch index={shown[k]!.i} />}
                {indexed.length > 1 && <span className="text-muted-foreground">{seriesName(shown[k]!.s)}</span>}
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

  const legend = indexed.filter(({ s }) => s.points.length > 0);
  return (
    <div className="grid gap-2">
      <div ref={ref} className="min-w-0">
        {body}
      </div>
      {legend.length > 1 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]" aria-label="Legend: click to hide or show">
          {legend.map(({ s, i }) => {
            const off = hidden.has(s.key);
            return (
              <li key={s.key}>
                <button
                  type="button"
                  aria-pressed={!off}
                  title={off ? `Show ${seriesName(s)}` : `Hide ${seriesName(s)}`}
                  onClick={() =>
                    setHidden((h) => {
                      const next = new Set(h);
                      if (off) next.delete(s.key);
                      else next.add(s.key);
                      return next;
                    })
                  }
                  className={cn("flex items-center gap-1.5 rounded px-1 hover:bg-accent", off && "opacity-40")}
                >
                  <Swatch index={i} />
                  <span className="text-muted-foreground">{seriesName(s)}</span>
                  <span className="tabular-nums">{formatNumber(s.points[s.points.length - 1]![1])}</span>
                </button>
              </li>
            );
          })}
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
