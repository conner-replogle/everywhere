import { useEffect, useState } from "react";
import { useHub } from "@/lib/hub";

/** Only shows up when the signaling socket is down; silence means healthy. */
export function HubStatus() {
  const { status } = useHub();
  const down = status === "connecting" || status === "closed";
  // Don't flash on the initial connect; only report sustained trouble.
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!down) return setShow(false);
    const t = setTimeout(() => setShow(true), 2000);
    return () => clearTimeout(t);
  }, [down]);
  if (!down || !show) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-warn" role="status" title="Reconnecting to server…">
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-warn" />
      <span className="truncate">Reconnecting…</span>
    </span>
  );
}
