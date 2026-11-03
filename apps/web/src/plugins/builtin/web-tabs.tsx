// Web tabs: pages opened from links (a process's web UI, a link in Claude's
// reply) as tabs of a thread, loaded here rather than on the device. In the
// desktop app each is a page of its own with a browser's toolbar; in a
// browser, which can't show most sites inside another page, they say so.
// Unlike the browser tab, Claude can't see or drive them, but they can be
// annotated for the chat as the browser tab can.

import { AppWindowIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { closeWebTab, renameWebTab, useWebTabs } from "@/lib/web-tabs";
import { definePlugin, type LocalTab } from "../types";

const WebView = lazy(() => import("@/components/web/web-view").then((m) => ({ default: m.WebView })));

function useLocalWebTabs(deviceId: string, threadId: string): LocalTab[] {
  return useWebTabs(deviceId, threadId).map((t) => ({
    id: t.id,
    kind: "web",
    name: t.name,
    parentId: threadId,
    data: t.url,
    icon: t.icon,
  }));
}

export const webTabs = definePlugin({
  id: "web-tabs",
  title: "Browser",
  tabs: [
    {
      kind: "web",
      title: "Browser",
      icon: AppWindowIcon,
      local: true,
      multiple: true,
      capture: "all",
      create: async (ctx) => ctx.openUrl("about:blank", { fresh: true }),
      render: (ctx) => (
        <Suspense>
          <WebView
            deviceId={ctx.deviceId}
            threadId={ctx.threadId}
            tabId={ctx.pane.id}
            url={String((ctx.pane as LocalTab).data ?? "")}
            shown={ctx.shown}
            onOpenTab={(url, background) => ctx.openUrl(url, { fresh: true, background })}
            onNewTab={() => ctx.openUrl("about:blank", { fresh: true })}
            onClose={ctx.close}
            onAnnotate={ctx.sendToClaude}
          />
        </Suspense>
      ),
    },
  ],
  localTabs: {
    use: useLocalWebTabs,
    close: closeWebTab,
    rename: renameWebTab,
  },
});
