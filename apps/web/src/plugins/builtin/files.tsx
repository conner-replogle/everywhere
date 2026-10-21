// The files plugin: the files tab.

import { FolderTreeIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { definePlugin } from "../types";

const FilesView = lazy(() => import("@/components/files/files-view").then((m) => ({ default: m.FilesView })));

export const files = definePlugin({
  id: "files",
  title: "Files",
  requires: { plugins: ["files"], features: ["tabs"] },
  tabs: [
    {
      kind: "files",
      title: "Files",
      icon: FolderTreeIcon,
      render: (ctx) => (
        <Suspense>
          <FilesView
            peer={ctx.peer}
            root={ctx.cwd ?? "~"}
            initialState={ctx.pane.tabState}
            onStateChange={ctx.setTabState}
          />
        </Suspense>
      ),
    },
  ],
});
