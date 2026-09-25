import { createFileRoute } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { Section } from "@/components/settings-section";
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
    </div>
  );
}
