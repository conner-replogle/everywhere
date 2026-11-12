// Pinning a thread from its header: a pinned thread is always listed in the
// sidebar, on every device, never tucked away as idle or done.

import { PinIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { definePlugin, type ThreadContext } from "../types";

function PinButton({ ctx }: { ctx: ThreadContext }) {
  const [busy, setBusy] = useState(false);
  if (ctx.archived) return null;
  const pinned = !!ctx.thread.pinnedAt;
  async function toggle() {
    setBusy(true);
    try {
      await ctx.peer.call("threads.pin", { id: ctx.threadId, pinned: !pinned });
      ctx.entry.threads.refetch();
    } catch {
      // the sidebar's menu says why, if it keeps failing
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="shrink-0"
      disabled={busy}
      onClick={() => void toggle()}
      aria-pressed={pinned}
      aria-label={pinned ? "Unpin thread" : "Pin thread"}
      title={pinned ? "Pinned: always in the sidebar. Click to unpin." : "Pin: keep it in the sidebar, never tucked away"}
    >
      <PinIcon className={cn(pinned ? "fill-current text-primary" : "text-muted-foreground")} />
    </Button>
  );
}

export const pin = definePlugin({
  id: "pin",
  title: "Pinned threads",
  requires: { plugins: ["done"], features: ["pin"] },
  threadHeader: [PinButton],
});
