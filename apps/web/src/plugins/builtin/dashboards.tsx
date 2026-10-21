// The dashboards plugin: a process's Dashboard view in the processes tab,
// the React page the model wrote for it, in a sandboxed frame.

import { lazy, Suspense } from "react";
import { definePlugin } from "../types";

const DashboardView = lazy(() =>
  import("@/components/processes/dashboard-view").then((m) => ({ default: m.DashboardView })),
);

export const dashboards = definePlugin({
  id: "dashboards",
  title: "Dashboards",
  requires: { plugins: ["dashboards"], features: ["processes"] },
  views: {
    "process.view": [
      {
        id: "dashboard",
        order: 10,
        label: "Dashboard",
        when: ({ process: p }) => !!p.dashboard,
        rank: () => 0,
        // It would start over.
        keepMounted: true,
        render: ({ peer, process }) => (
          <Suspense>
            <DashboardView key={process.id} peer={peer} process={process} />
          </Suspense>
        ),
      },
    ],
  },
});
