// The cards the assistant has put on screen (lib/assistant/screen.ts): the
// same on every device, gone once they're no longer in use. Dismissing one
// hides it in this tab until the assistant shows it again.

import { XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Markdown } from "@/components/agent/markdown";
import { Button } from "@/components/ui/button";
import { screenCards } from "@/lib/assistant/screen";
import { useAssistantSync } from "@/lib/assistant/sync";
import { cn } from "@/lib/utils";

export function ScreenCards({ className }: { className?: string }) {
  const { entries } = useAssistantSync();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const cards = useMemo(() => screenCards(entries).filter((c) => !dismissed.has(`${c.id}:${c.seq}`)), [entries, dismissed]);
  if (!cards.length) return null;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {cards.map((c) => (
        <section
          key={c.id}
          aria-label="From the assistant"
          className="relative max-h-[min(24rem,45vh)] overflow-y-auto rounded-xl border border-border bg-background/95 px-4 py-3 text-sm shadow-xl backdrop-blur animate-in fade-in slide-in-from-bottom-2 duration-200"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-2"
            onClick={() => setDismissed((d) => new Set(d).add(`${c.id}:${c.seq}`))}
            aria-label="Dismiss this card"
          >
            <XIcon />
          </Button>
          <Markdown text={c.markdown} className="pr-6" />
        </section>
      ))}
    </div>
  );
}
