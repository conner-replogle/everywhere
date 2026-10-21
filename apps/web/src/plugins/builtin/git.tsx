// The git plugin: a thread's checkout in its header.

import { GitChip } from "@/components/git-chip";
import { definePlugin, type ThreadContext } from "../types";

function Chip({ ctx }: { ctx: ThreadContext }) {
  if (ctx.archived || ctx.inScratch) return null;
  return <GitChip peer={ctx.peer} threadId={ctx.threadId} />;
}

export const git = definePlugin({
  id: "git",
  title: "Git",
  requires: { plugins: ["git"], features: ["gitStatus"] },
  threadHeader: [Chip],
});
