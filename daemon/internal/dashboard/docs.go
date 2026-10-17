package dashboard

// Docs is how to write a dashboard, for the model (dashboard_docs).
const Docs = `# Dashboards

Most processes need no dashboard: whatever a process reports to its telemetry
(POST $EVERYWHERE_TELEMETRY/log, /event, /attach; see process_start) is
charted with it already, each metric over steps or time, with its runs side by
side and what it uploaded. Write a dashboard when that isn't enough: a custom
layout, a derived view, a diagram, a picker, a visual of your own.

A dashboard is a small React app, drawn in the everywhere app's own style. It
belongs to a process and shows its project's telemetry: the process gets and
crunches the data and logs it; the dashboard asks for what it shows.

## Files

  .everywhere/dashboards/<name>/index.tsx   default-exports the dashboard component
  .everywhere/dashboards/<name>/*.ts(x)     anything else it imports (and .css)
  .everywhere/types/everywhere.d.ts         the API (written by dashboard_build)
  .everywhere/telemetry.db, files/          what processes reported (gitignored)

Use .tsx with React. Import React from "react" and the components and hooks
from "everywhere". npm packages resolve from node_modules as usual (the
project's, or install into .everywhere/dashboards/<name>). The daemon bundles
it with esbuild: run dashboard_build after each change for errors with
file:line; viewers that have it open reload on their own.

## Showing it

  process_start {name: "train", command: "python train.py", dashboard: "train"}

or attach one later with process_report {name, dashboard}, or from the
process: POST $EVERYWHERE_TELEMETRY/progress {"dashboard": "train"}.

## Getting data

The dashboard runs sandboxed in the browser with no network. It asks the
device, over the app's connection, for just what it draws:

- useQuery({metric, where, groupBy, x, from, to, points}): a metric, bucketed
  on the device to about points per series (the chart's width), so a run of
  millions of points comes back as a few hundred. By default it's the
  process's experiment, every run, a series per run; where.run narrows it.
  It asks again when the metric gets data.
- useCatalog(): the experiment's runs (with status) and metrics.
- useTelemetryEvents({kind, runs, limit}): events, newest first. Uploads are
  kind "attachment" with data {path, name, type, step, caption}: show them
  with <Image path> or <Video path>.
- useProcess(): the process: status, stats, checkpoints, status text, run.
- useLog({tail, grep}): its output.
- <Widget id>: a widget it declared.
- useFile/useText/useJSON(path): other files in the project.

Runs are how versions compare: every start of a process is a new run of its
experiment (train#1, train#2, or the run name given to process_start), and
all of an experiment's runs stay in the project after their processes end.

## Keep no state in the browser

A dashboard must look the same after a reload, on another device, and after
the daemon restarts. So it holds nothing of its own: what it shows comes from
the device (queries, events, files), and anything the user picks (a tab, a
run, a filter) goes in useDashboardState, which keeps it in the project. useState
only for what may be forgotten, like hover. localStorage and cookies don't
work in its frame. Never fetch everything to filter it here: put it in the
query.

## Looking right

Build from the components: Grid, Card, Stat, LineChart, BarChart, Gauge,
Table, Image, Video, Empty. They follow the user's theme (light or dark, any
palette). For a custom visual (an SVG, a canvas, a diagram, a map) keep it
in a Card and use the theme: theme.series[i] and the other theme colors as
CSS values in SVG and style, useThemeColors() for canvas, and Tailwind classes
with the app's colors (bg-card, bg-muted, text-muted-foreground, border,
text-primary, bg-chart-1..4, text-live/warn/destructive). Don't hardcode
colors or fonts. Series colors identify things (series i is always the same
thing); live/warn/destructive mean good/warning/critical and come with a word
or icon. Text stays in text colors, not series colors. Keep it calm: thin
lines, few labels, numbers formatted with formatNumber/formatDuration.

## Example

  // .everywhere/dashboards/train/index.tsx
  import { Card, Grid, Image, LineChart, Stat, useCatalog, useDashboardState, useProcess,
    useQuery, useTelemetryEvents, type Attachment } from "everywhere";

  export default function Dashboard() {
    const p = useProcess();
    const runs = useCatalog().data?.runs ?? [];
    const [run, setRun] = useDashboardState<string | null>("run", null);
    const shown = run ?? p.run ?? "";
    const loss = useQuery({ metric: "loss", where: { run: [shown] }, points: 400 });
    const val = useQuery({ metric: "val_loss", points: 400 }); // every run
    const sample = useTelemetryEvents<Attachment>({ kind: "attachment", runs: [shown], limit: 1 }).events[0];
    const last = loss.data?.series[0]?.points.at(-1);
    return (
      <Grid>
        <div className="col-span-full flex gap-1 text-xs">
          {runs.map((r) => (
            <button key={r.run} onClick={() => setRun(r.run)}
              className={r.run === shown ? "rounded bg-accent px-2" : "rounded px-2 text-muted-foreground"}>
              {r.run}
            </button>
          ))}
        </div>
        <Stat label="Loss" value={last?.[1]} hint={last && "step " + last[0]} />
        <Card title="Validation loss" wide>
          <LineChart xLabel="step" series={(val.data?.series ?? []).map((s) => ({ key: s.labels.run, points: s.points }))} />
        </Card>
        {sample && <Card title="Latest sample"><Image path={sample.data.path} refresh={sample.id} /></Card>}
      </Grid>
    );
  }

and in train.py:

  T = {"X-Everywhere-Token": os.environ["EVERYWHERE_TOKEN"]}
  URL = os.environ["EVERYWHERE_TELEMETRY"]
  requests.post(URL + "/log", json={"step": step, "metrics": {"loss": loss, "val_loss": val}}, headers=T)
  requests.post(URL + f"/attach?name=sample_{step}.png&step={step}", data=open(path, "rb"), headers=T)

For data that comes from elsewhere (a database, an API), the process polls
it in a loop and logs what it found; the dashboard only asks and draws.
`
