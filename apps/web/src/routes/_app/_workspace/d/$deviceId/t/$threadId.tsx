import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/_workspace/d/$deviceId/t/$threadId")({
  // tab: the pane shown (the thread itself if absent); split: one shown beside it.
  validateSearch: (search: Record<string, unknown>): { tab?: string; split?: string } => ({
    ...(typeof search.tab === "string" ? { tab: search.tab } : {}),
    ...(typeof search.split === "string" ? { split: search.split } : {}),
  }),
  // The workspace draws threads itself (components/thread-grid), so one
  // can stay on screen beside others while the URL moves between them.
  component: () => null,
});
