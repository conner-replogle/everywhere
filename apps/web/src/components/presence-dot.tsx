import { cn } from "@/lib/utils";

/** `undefined` = presence not known yet. */
export function PresenceDot({ online, className }: { online: boolean | undefined; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        online === true && "bg-live [animation:live-arrive_900ms_ease-out_1]",
        online === false && "border border-muted-foreground/50",
        online === undefined && "bg-muted-foreground/25",
        className,
      )}
    />
  );
}
