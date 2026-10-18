import type {
  Process,
  TelemetryAttachment,
  TelemetryEvent,
  TelemetryMetric,
  TelemetryRun,
  TelemetryScope,
} from "@everywhere/protocol";
import { FileIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { DevicePeer } from "@/lib/peer";
import { useCatalog, useDebounced, useTelemetryChanged, useTelemetryQuery, ZOOM_ASK_MS } from "@/lib/telemetry";
import { cn, errorMessage } from "@/lib/utils";
import { formatDuration } from "./progress";
import { Card, Empty, Grid, LineChart, ProcessWidgets, SERIES_COLORS, type XRange } from "./widgets";

/** Runs a chart compares at most: one color each. */
const MAX_RUNS = SERIES_COLORS.length;

/**
 * What a process reported, charted with no work from whoever wrote it: each
 * metric over steps or time, a line per run (this one, and others of its
 * experiment to compare), what its runs uploaded, and its widgets.
 */
export function TelemetryView({
  peer,
  process: p,
  compare,
  onCompare,
}: {
  peer: DevicePeer;
  process: Process;
  /** Other runs of the experiment shown alongside this one. */
  compare: string[];
  onCompare: (runs: string[]) => void;
}) {
  const scope: TelemetryScope = { processId: p.id };
  const catalog = useCatalog(peer, scope, p.home, p.experiment);
  const runs = catalog.data?.runs ?? [];
  const shown = useMemo(
    () => [p.run!, ...compare.filter((r) => r !== p.run && runs.some((x) => x.run === r))].slice(0, MAX_RUNS),
    [p.run, compare, runs],
  );
  const metrics = catalog.data?.metrics ?? [];
  // Charts on the same axis zoom together; the device is asked once zooming pauses.
  const [zoom, setZoom] = useState<Record<"step" | "time", XRange | null>>({ step: null, time: null });
  const asked = useDebounced(zoom, ZOOM_ASK_MS);
  useEffect(() => setZoom({ step: null, time: null }), [p.id, p.experiment]);
  const hasWidgets = (p.widgets?.length ?? 0) > 0;

  if (!p.experiment || !p.run) return hasWidgets ? <ProcessWidgets process={p} /> : <Empty>No telemetry</Empty>;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <RunPicker
        runs={runs}
        current={p.run}
        shown={shown}
        onChange={(next) => onCompare(next.filter((r) => r !== p.run))}
      />
      {catalog.error && <p className="px-3 text-xs text-destructive">{catalog.error}</p>}
      <Grid className="p-3 pt-0">
        {metrics.length === 0 && !hasWidgets && (
          <div className="col-span-full">
            <Empty>
              {catalog.loading
                ? "Loading…"
                : "Nothing reported yet: metrics the process sends to $EVERYWHERE_TELEMETRY/log show up here."}
            </Empty>
          </div>
        )}
        {metrics.map((m) => {
          const axis = m.steps ? "step" : "time";
          return (
            <MetricCard
              key={m.name}
              peer={peer}
              process={p}
              metric={m}
              runs={shown}
              zoom={zoom[axis]}
              asked={asked[axis]}
              onZoom={(range) => setZoom((z) => ({ ...z, [axis]: range }))}
            />
          );
        })}
      </Grid>
      <Attachments peer={peer} process={p} runs={shown} />
      {hasWidgets && <ProcessWidgets process={p} />}
    </div>
  );
}

function RunPicker({
  runs,
  current,
  shown,
  onChange,
}: {
  runs: TelemetryRun[];
  current: string;
  shown: string[];
  onChange: (runs: string[]) => void;
}) {
  const others = runs.filter((r) => !shown.includes(r.run)).reverse();
  return (
    <div className="flex flex-wrap items-center gap-1.5 p-3 text-xs">
      {shown.map((run, i) => {
        const info = runs.find((r) => r.run === run);
        return (
          <span key={run} className="flex items-center gap-1.5 rounded-md border px-2 py-0.5">
            <span className="size-2 rounded-full" style={{ background: SERIES_COLORS[i] }} />
            <span className="font-medium">{run}</span>
            {info && <span className="text-muted-foreground">{runLabel(info)}</span>}
            {run !== current && (
              <button
                type="button"
                className="-mr-1 rounded text-muted-foreground hover:text-foreground"
                aria-label={`Stop comparing ${run}`}
                onClick={() => onChange(shown.filter((r) => r !== run))}
              >
                <XIcon className="size-3" />
              </button>
            )}
          </span>
        );
      })}
      {others.length > 0 && shown.length < MAX_RUNS && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 text-xs">
              <PlusIcon />
              Compare
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {others.map((r) => (
              <DropdownMenuItem key={r.run} onSelect={() => onChange([...shown, r.run])} className="text-xs">
                <span className="font-medium">{r.run}</span>
                <span className="ml-auto pl-4 text-muted-foreground">{runLabel(r)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function runLabel(r: TelemetryRun): string {
  const took = ((r.endedAt ?? Date.now()) - r.startedAt) / 1000;
  return r.endedAt ? `${r.status} · ${formatDuration(took)}` : `running · ${formatDuration(took)}`;
}

/** One metric: a line per run, asked of the device at about the chart's width. */
function MetricCard({
  peer,
  process: p,
  metric,
  runs,
  zoom,
  asked,
  onZoom,
}: {
  peer: DevicePeer;
  process: Process;
  metric: TelemetryMetric;
  runs: string[];
  /** The range shown, and the one asked of the device (it lags while zooming). */
  zoom: XRange | null;
  asked: XRange | null;
  onZoom: (range: XRange | null) => void;
}) {
  const from = asked?.[0];
  const to = asked?.[1];
  const query = useMemo(
    () => ({
      metric: metric.name,
      where: { experiment: [p.experiment!], run: runs },
      groupBy: ["run"],
      x: metric.steps ? ("step" as const) : ("time" as const),
      // Zoomed in, the device buckets just that range: more detail, not a blur.
      ...(from !== undefined && to !== undefined ? { from, to } : {}),
      points: 600,
    }),
    [metric.name, metric.steps, p.experiment, runs, from, to],
  );
  const res = useTelemetryQuery(peer, { processId: p.id }, p.home, p.experiment, query);
  // Series in the order of the runs, so each run keeps its color.
  const series = runs.flatMap((run) => {
    const s = res.data?.series.find((x) => x.labels.run === run);
    return s ? [{ key: run, label: run, points: s.points }] : [];
  });
  return (
    <Card title={metric.name} wide>
      {res.error ? (
        <Empty>{res.error}</Empty>
      ) : (
        <LineChart
          series={series}
          xLabel={metric.steps ? "step" : undefined}
          title={metric.name}
          zoom={zoom}
          onZoom={onZoom}
        />
      )}
    </Card>
  );
}

/** Files the runs uploaded (POST /attach), newest first. */
function Attachments({ peer, process: p, runs }: { peer: DevicePeer; process: Process; runs: string[] }) {
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [tick, setTick] = useState(0);
  const runsKey = runs.join("\u0000");
  useEffect(() => {
    if (!p.experiment) return;
    let live = true;
    peer
      .call("telemetry.events", {
        processId: p.id,
        experiment: p.experiment,
        runs: runsKey.split("\u0000"),
        kind: "attachment",
        limit: 12,
      })
      .then((evs) => live && setEvents(evs))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [peer, p.id, p.experiment, runsKey, tick]);
  useTelemetryChanged(peer, p.home, p.experiment, undefined, () => setTick((t) => t + 1));
  if (events.length === 0) return null;
  return (
    <section className="grid gap-2 px-3 pb-3">
      <h3 className="text-xs font-medium">Attachments</h3>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
        {events.map((e) => (
          <AttachmentCard key={e.id} peer={peer} processId={p.id} event={e} colored={runs.length > 1} runIndex={runs.indexOf(e.run)} />
        ))}
      </div>
    </section>
  );
}

function AttachmentCard({
  peer,
  processId,
  event,
  colored,
  runIndex,
}: {
  peer: DevicePeer;
  processId: string;
  event: TelemetryEvent;
  colored: boolean;
  runIndex: number;
}) {
  const a = event.data as TelemetryAttachment;
  const media = a.type.startsWith("image/") ? "image" : a.type.startsWith("video/") ? "video" : null;
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!media) return;
    let live = true;
    let made: string | undefined;
    (async () => {
      try {
        const f = await peer.call("processes.file", { id: processId, path: a.path });
        const { bytes } = await peer.readFile(f.path);
        if (!live) return;
        made = URL.createObjectURL(new Blob([bytes], { type: a.type }));
        setUrl(made);
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    })();
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [peer, processId, a.path, a.type, media]);
  return (
    <figure className="grid min-w-0 gap-1 rounded-md border bg-card p-1.5 text-[11px]">
      <div className="flex aspect-video items-center justify-center overflow-hidden rounded bg-muted">
        {url && media === "image" && <img src={url} alt={a.caption ?? a.name} className="max-h-full max-w-full object-contain" />}
        {url && media === "video" && <video src={url} controls playsInline className="max-h-full max-w-full" />}
        {!url && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <FileIcon className="size-4" />
            {error ?? (media ? "Loading…" : a.name)}
          </span>
        )}
      </div>
      <figcaption className="flex min-w-0 items-center gap-1.5">
        {colored && runIndex >= 0 && (
          <span className="size-2 shrink-0 rounded-full" style={{ background: SERIES_COLORS[runIndex] }} />
        )}
        <span className={cn("truncate", !a.caption && "text-muted-foreground")} title={a.caption ?? a.name}>
          {a.caption ?? a.name}
        </span>
        {a.step !== undefined && <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">step {a.step}</span>}
      </figcaption>
    </figure>
  );
}
