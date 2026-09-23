import { cn } from "@/lib/utils";

/** Prompt chevron + a live dot: a shell, somewhere, that's up. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight text-foreground", className)}>
      <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
        <rect width="32" height="32" rx="7" fill="#1d2129" />
        <path
          d="M8 11l6 5-6 5"
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="22.5" cy="20.5" r="3" fill="var(--live)" />
      </svg>
      everywhere
    </span>
  );
}
