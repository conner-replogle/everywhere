import type { DesktopUpdateState } from "@everywhere/protocol";
import { ArrowDownCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { desktop } from "@/lib/desktop";
import { cn } from "@/lib/utils";

/** Where the desktop app's own update is; undefined outside the app or in apps from before it. */
export function useDesktopUpdate(): DesktopUpdateState | undefined {
  const [state, setState] = useState<DesktopUpdateState>();
  useEffect(() => {
    const update = desktop?.update;
    if (!update) return;
    let live = true;
    const off = update.onChange(setState);
    void update.state().then((s) => live && setState((cur) => cur ?? s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

/**
 * Next to the logo in the desktop app: its version (click to check for
 * updates), a download in progress, and a button to restart into one that's
 * ready. Nothing in a browser.
 */
export function AppVersion() {
  const update = useDesktopUpdate();
  if (!desktop?.version) return null;
  const canCheck = !!desktop.update && update?.t !== "unsupported" && update?.t !== "checking";
  const title =
    update?.t === "checking"
      ? "Checking for updates…"
      : update?.t === "error"
        ? `Couldn't check for updates: ${update.message}`
        : canCheck
          ? "Check for updates"
          : `Everywhere ${desktop.version}`;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        disabled={!canCheck}
        onClick={() => desktop?.update?.check()}
        title={title}
        className={cn(
          "rounded-sm font-mono text-[11px] text-muted-foreground tabular-nums focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
          canCheck && "hover:text-foreground",
          update?.t === "error" && "text-warn",
        )}
      >
        v{desktop.version}
      </button>
      {update?.t === "downloading" && (
        <span
          className="text-[11px] text-muted-foreground tabular-nums"
          role="status"
          title={`Downloading Everywhere ${update.version}`}
        >
          ↓ {update.percent}%
        </span>
      )}
      {update?.t === "ready" && (
        <button
          type="button"
          onClick={() => desktop?.update?.install()}
          title={`Restart to update to ${update.version}`}
          className="flex h-5 items-center gap-1 rounded-full bg-primary px-2 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        >
          <ArrowDownCircleIcon className="size-3" />
          Update
        </button>
      )}
    </span>
  );
}
