import { createFileRoute } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { Section } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { PERMISSION_MODES } from "@/lib/permission-modes";
import { setPref, usePrefs } from "@/lib/prefs";
import { cn, errorMessage } from "@/lib/utils";

export const Route = createFileRoute("/_app/_workspace/settings/claude")({
  component: ClaudeSettings,
});

function ClaudeSettings() {
  const prefs = usePrefs();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-base font-semibold tracking-tight">Claude</h1>
        <p className="text-xs text-muted-foreground">Defaults for new Claude threads, on every device and browser.</p>
      </div>
      <Section
        title="Default permission mode"
        description="What a new thread or Claude tab starts in. Change it for one thread from its composer."
      >
        <div role="radiogroup" aria-label="Default permission mode" className="grid gap-1">
          {PERMISSION_MODES.map((m) => {
            const on = prefs.defaultPermissionMode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setError(null);
                  setPref("defaultPermissionMode", m.value).catch((e: unknown) => setError(errorMessage(e)));
                }}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-3 py-2 text-left focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
                  on ? "border-primary/60 bg-accent" : "border-transparent hover:bg-accent/60",
                )}
              >
                <span className="grid min-w-0 flex-1">
                  <span className={cn(m.value === "bypassPermissions" && "text-destructive")}>{m.label}</span>
                  <span className="text-xs text-muted-foreground">{m.hint}</span>
                </span>
                {on && <CheckIcon className="size-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
        {error && <p className="mt-2 text-destructive">{error}</p>}
      </Section>
      <Section
        title="Automatic recaps"
        description="Coming back to a thread that's been idle 5+ minutes asks Claude for a one-line recap of where it stands, like Claude Code does in the terminal. Each recap is a short turn and costs a little."
        aside={
          <Button
            size="sm"
            variant={prefs.autoRecap ? "outline" : "default"}
            onClick={() => {
              setError(null);
              setPref("autoRecap", !prefs.autoRecap).catch((e: unknown) => setError(errorMessage(e)));
            }}
          >
            {prefs.autoRecap ? "Turn off" : "Turn on"}
          </Button>
        }
      >
        <p className="text-muted-foreground">
          {prefs.autoRecap
            ? "On. Type /recap in a thread to ask for one any time."
            : "Off. Type /recap in a thread to ask for one."}
        </p>
      </Section>
    </div>
  );
}
