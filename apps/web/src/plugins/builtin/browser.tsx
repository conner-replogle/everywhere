// The browser plugin: the thread's page in the device's Chromium, opened as
// a tab when claude starts using it.

import { GlobeIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { definePlugin } from "../types";

const BrowserView = lazy(() => import("@/components/browser/browser-view").then((m) => ({ default: m.BrowserView })));

const BROWSER_TOOL = /^mcp__everywhere__browser_/;

export const browser = definePlugin({
  id: "browser",
  title: "Browser",
  requires: { plugins: ["browser"], features: ["tabs"] },
  tabs: [
    {
      kind: "browser",
      title: "Browser (device)",
      icon: GlobeIcon,
      // One per thread: a second tab would show the same page.
      single: true,
      capture: "all",
      // It only streams while shown.
      unmountHidden: true,
      render: (ctx) => (
        <Suspense>
          <BrowserView
            peer={ctx.peer}
            // Daemons from before tabs have their project's browser.
            threadId={ctx.hasFeature("tabs") ? ctx.threadId : ctx.thread.projectId}
            generation={ctx.generation}
            remoteOs={ctx.info?.os}
            onAnnotate={ctx.sendToClaude}
          />
        </Suspense>
      ),
    },
  ],
  on: {
    // Open the browser as a tab when claude uses it, but not right after the user closed it.
    "agent.toolUses": ({ uses }, ctx) => {
      if (!ctx.canTab || ctx.closedRecently("browser", 120_000)) return;
      if (uses.some((u) => u.recent && BROWSER_TOOL.test(u.name))) void ctx.openTab("browser", { focus: false });
    },
  },
});
