// The voice screen's inbox: the threads that finished or need the user
// (lib/alerts, one row per thread, newest first), so a call shows what's
// happening across them. They stay until opened or swiped away; tapping one
// opens the thread and tucks the voice screen away (still listening).

import { notifyNeedsYou, notifyText } from "@everywhere/protocol";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { KIND_ICON } from "@/components/alerts";
import { useFleet } from "@/components/fleet";
import { type Alert, alertThread, dismissAlert, useAlerts } from "@/lib/alerts";
import { cn } from "@/lib/utils";
import { useSwipeAway } from "./swipe";

export function VoiceInbox({ onOpen, className }: { onOpen: () => void; className?: string }) {
  const alerts = useAlerts();
  if (!alerts.length) return null;
  return (
    <section aria-label="Your threads" aria-live="polite" className={cn("flex flex-col gap-1.5", className)}>
      {[...alerts].reverse().map((a) => (
        <InboxRow key={a.id} alert={a} onOpen={onOpen} />
      ))}
    </section>
  );
}

function InboxRow({ alert: a, onOpen }: { alert: Alert; onOpen: () => void }) {
  const navigate = useNavigate();
  const { devices } = useFleet();
  const device = devices?.find((d) => d.id === a.deviceId)?.name;
  const needsYou = notifyNeedsYou(a.kind);
  const Icon = KIND_ICON[a.kind];
  const swipe = useSwipeAway(() => dismissAlert(a.id), ["left", "right"]);
  const open = () => {
    if (swipe.swiped()) return;
    dismissAlert(a.id);
    onOpen();
    void navigate({
      to: "/d/$deviceId/t/$threadId",
      params: { deviceId: a.deviceId, threadId: alertThread(a) },
      search: a.parentId ? { tab: a.threadId } : {},
    });
  };
  return (
    <button
      type="button"
      {...swipe.handlers}
      style={swipe.style}
      onClick={open}
      className={cn(
        "flex w-full touch-pan-y items-center gap-2.5 rounded-xl border bg-background/80 px-3 py-2 text-left text-sm shadow-lg backdrop-blur-md animate-in fade-in slide-in-from-top-2 duration-200 motion-reduce:animate-none",
        needsYou ? "border-warn/50" : "border-border",
      )}
    >
      <Icon className={cn("size-4 shrink-0", a.kind === "error" ? "text-destructive" : needsYou ? "text-warn" : "text-live")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{a.name.trim() || "Claude"}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {notifyText(a)}
          {device ? ` · ${device}` : ""}
        </span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
