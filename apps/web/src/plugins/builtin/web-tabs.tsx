// Web tabs: pages opened from links (a process's web UI, a link in Claude's
// reply) as tabs of a thread, in an iframe in this browser. Unlike the
// browser tab, they run here and Claude can't see or drive them.

import { AppWindowIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { closeWebTab, renameWebTab, useWebTabs } from "@/lib/web-tabs";
import { definePlugin, type LocalTab } from "../types";

const WebView = lazy(() => import("@/components/web/web-view").then((m) => ({ default: m.WebView })));

function useLocalWebTabs(deviceId: string, threadId: string): LocalTab[] {
  return useWebTabs(deviceId, threadId).map((t) => ({ id: t.id, kind: "web", name: t.name, parentId: threadId, data: t.url }));
}

export const webTabs = definePlugin({
  id: "web-tabs",
  title: "Web tabs",
  tabs: [
    {
      kind: "web",
      title: "Web page",
      icon: AppWindowIcon,
      local: true,
      create: async (ctx) => {
        const address = await ctx.prompt({
          title: "Open a web page",
          label: "Address",
          placeholder: "https://example.com",
          submitLabel: "Open",
        });
        if (!address?.trim()) return;
        const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(address.trim()) ? address.trim() : `https://${address.trim()}`;
        ctx.openUrl(url);
      },
      render: (ctx) => (
        <Suspense>
          <WebView url={String((ctx.pane as LocalTab).data ?? "")} />
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
