// Toasts for claude threads on any device that finished or need the user,
// with a button to switch to the thread.

import { type NotifyKind, notifyNeedsYou, notifyText } from "@everywhere/protocol";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  CircleAlertIcon,
  ClipboardListIcon,
  type LucideIcon,
  MessageCircleQuestionIcon,
  ShieldIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useFleet } from "@/components/fleet";
import { Button } from "@/components/ui/button";
import { type Alert, alertThread, dismissAlert, useAlerts } from "@/lib/alerts";
import { cn } from "@/lib/utils";

/** How long a "finished" or "error" alert stays up while the page is visible. */
const DONE_TIMEOUT_MS = 8_000;

const KIND_ICON: Record<NotifyKind, LucideIcon> = {
  permission: ShieldIcon,
  question: MessageCircleQuestionIcon,
  plan: ClipboardListIcon,
  done: CheckIcon,
  error: CircleAlertIcon,
};

export function Alerts() {
  const alerts = useAlerts();
  if (alerts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-40 flex flex-col-reverse items-center gap-2 px-4 sm:inset-x-auto sm:top-auto sm:right-4 sm:bottom-4 sm:flex-col sm:items-end sm:px-0"
    >
      {alerts.map((a) => (
        <AlertToast key={a.id} alert={a} />
      ))}
    </div>
  );
}

function AlertToast({ alert: a }: { alert: Alert }) {
  const navigate = useNavigate();
  const { devices } = useFleet();
  const device = devices?.find((d) => d.id === a.deviceId)?.name;
  const needsYou = notifyNeedsYou(a.kind);
  const Icon = KIND_ICON[a.kind];
  const hovered = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Alerts that need nothing from the user go away on their own, counting only
  // while they can be seen.
  const arm = () => {
    clearTimeout(timer.current);
    if (needsYou || hovered.current || document.visibilityState !== "visible") return;
    timer.current = setTimeout(() => dismissAlert(a.id), DONE_TIMEOUT_MS);
  };
  useEffect(() => {
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", arm);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id]);

  const open = () => {
    dismissAlert(a.id);
    void navigate({
      to: "/d/$deviceId/t/$threadId",
      params: { deviceId: a.deviceId, threadId: alertThread(a) },
      search: a.parentId ? { tab: a.threadId } : {},
    });
  };

  return (
    <div
      role={needsYou ? "alert" : "status"}
      onMouseEnter={() => {
        hovered.current = true;
        arm();
      }}
      onMouseLeave={() => {
        hovered.current = false;
        arm();
      }}
      className="pointer-events-auto flex w-full max-w-sm animate-in items-center gap-3 rounded-lg border bg-popover py-2.5 pr-2 pl-3 text-popover-foreground shadow-xl shadow-black/40 fade-in-0 slide-in-from-top-2 sm:w-80 sm:slide-in-from-bottom-2"
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          a.kind === "error" ? "text-destructive" : needsYou ? "text-warn" : "text-live",
        )}
      />
      <button type="button" onClick={open} className="min-w-0 flex-1 text-left outline-none">
        <div className="truncate font-medium">{a.name.trim() || "Claude"}</div>
        <div className="truncate text-xs text-muted-foreground">
          {notifyText(a)}
          {device ? ` · ${device}` : ""}
        </div>
      </button>
      <Button size="sm" variant={needsYou ? "default" : "secondary"} onClick={open}>
        Switch
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => dismissAlert(a.id)}>
        <XIcon />
      </Button>
    </div>
  );
}
