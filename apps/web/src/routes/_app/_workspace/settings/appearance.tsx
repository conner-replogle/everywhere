import { createFileRoute } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { Section } from "@/components/settings-section";
import { DEFAULT_THEME, OMARCHY, type Palette, setTheme, THEMES, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/_workspace/settings/appearance")({
  component: AppearanceSettings,
});

function AppearanceSettings() {
  const { choice, omarchy, theme } = useTheme();
  const following = theme.id === OMARCHY;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-base font-semibold tracking-tight">Appearance</h1>
        <p className="text-xs text-muted-foreground">Colors for this browser. Other devices keep their own.</p>
      </div>
      <Section
        title="Omarchy"
        description={
          omarchy ? (
            <>
              Follow the desktop's theme, <span className="text-foreground">{omarchy.name}</span>, and change with it.
            </>
          ) : (
            <>
              On an Omarchy computer, the everywhere Omarchy theme extension lets this page follow the desktop's theme.
              Install it with <code className="font-mono">extensions/omarchy-theme/install.sh</code>, then restart
              Chromium.
            </>
          )
        }
      >
        <Option
          on={following}
          disabled={!omarchy}
          onClick={() => setTheme(OMARCHY)}
          colors={omarchy?.colors}
          name={omarchy ? `Follow Omarchy (${omarchy.name})` : "Follow Omarchy"}
          hint={omarchy ? (choice === null ? "Used when nothing else is picked" : undefined) : "Extension not found"}
        />
      </Section>
      <Section title="Themes" description="Omarchy's themes, for anywhere. Picking one here stops following Omarchy.">
        <div role="radiogroup" aria-label="Theme" className="grid gap-1.5 sm:grid-cols-2">
          {THEMES.map((t) => (
            <Option
              key={t.id}
              on={theme.id === t.id}
              onClick={() => setTheme(t.id)}
              colors={t.colors}
              name={t.name}
              hint={t.id === DEFAULT_THEME ? "Default" : t.colors.mode === "light" ? "Light" : undefined}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}

function Option({
  on,
  disabled,
  onClick,
  colors,
  name,
  hint,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  colors?: Palette;
  name: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-md border px-2.5 py-2 text-left focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none disabled:opacity-50",
        on ? "border-primary/60 bg-accent" : "border-border hover:bg-accent/60",
      )}
    >
      <Swatch colors={colors} />
      <span className="grid min-w-0 flex-1">
        <span className="truncate">{name}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
      {on && <CheckIcon className="size-4 shrink-0 text-primary" />}
    </button>
  );
}

/** The theme's ground with its accent and a few terminal colors on it. */
function Swatch({ colors }: { colors?: Palette }) {
  const dots = colors ? [colors.accent, colors.red, colors.yellow, colors.green, colors.blue, colors.magenta] : [];
  return (
    <span
      className="flex h-8 w-16 shrink-0 flex-col justify-between rounded border px-1.5 py-1"
      style={colors && { background: colors.background, borderColor: colors.dark_background ?? colors.background }}
    >
      <span className="h-1 w-8 rounded-full" style={colors && { background: colors.foreground }} />
      <span className="flex gap-0.5">
        {dots.map((c, i) => (
          <span key={i} className="size-1.5 rounded-full" style={{ background: c ?? "transparent" }} />
        ))}
      </span>
    </span>
  );
}
