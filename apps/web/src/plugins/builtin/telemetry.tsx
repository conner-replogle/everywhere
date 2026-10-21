// The telemetry plugin: a process's Charts view in the processes tab (its
// metrics over runs, and its widgets).

import { lazy, Suspense } from "react";
import { definePlugin } from "../types";

const TelemetryView = lazy(() =>
  import("@/components/processes/telemetry-view").then((m) => ({ default: m.TelemetryView })),
);

export const telemetry = definePlugin({
  id: "telemetry",
  title: "Telemetry",
  requires: { plugins: ["telemetry"], features: ["processes"] },
  views: {
    "process.view": [
      {
        id: "charts",
        order: 20,
        label: "Charts",
        when: ({ process: p }) => !!p.experiment || (p.widgets?.length ?? 0) > 0,
        // Its widgets come before the log; charts that may well be empty (any
        // process can report; most don't) after it.
        rank: ({ process: p }) => ((p.widgets?.length ?? 0) > 0 ? 1 : 3),
        render: ({ peer, process, compare, onCompare }) => (
          <div className="flex h-full flex-col bg-background">
            <Suspense>
              <TelemetryView peer={peer} process={process} compare={compare} onCompare={onCompare} />
            </Suspense>
          </div>
        ),
      },
    ],
  },
});
