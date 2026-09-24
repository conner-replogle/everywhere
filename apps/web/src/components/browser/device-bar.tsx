import type { BrowserClientMsg, BrowserViewportSetting } from "@everywhere/protocol";
import { RotateCcwSquareIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BROWSER_PRESETS, presetById } from "@/lib/browser-presets";

const CATEGORIES = ["Phone", "Tablet", "Desktop"] as const;

/**
 * Chrome's device toolbar: shown while the tab emulates a device or a fixed
 * size rather than filling the panel.
 */
export function DeviceBar({
  viewport,
  scale,
  send,
}: {
  viewport: BrowserViewportSetting;
  /** How much the page is shrunk to fit, 0-1. */
  scale: number;
  send: (msg: BrowserClientMsg) => void;
}) {
  const preset = presetById(viewport.preset);
  const landscape = viewport.width > viewport.height;

  const setSize = (width: number, height: number) => {
    if (width > 0 && height > 0 && (width !== viewport.width || height !== viewport.height)) {
      send({ t: "viewport", mode: "freeform", width, height });
    }
  };

  return (
    <div className="flex h-8 shrink-0 items-center justify-center gap-1.5 border-b bg-sidebar/60 px-2 text-xs">
      <select
        aria-label="Device"
        className="h-6 max-w-40 min-w-0 rounded-sm border bg-background px-1 text-xs outline-none focus:border-ring"
        value={viewport.mode === "preset" ? (viewport.preset ?? "") : ""}
        onChange={(e) => {
          const id = e.target.value;
          if (!id) setSize(viewport.width, viewport.height);
          else send({ t: "viewport", mode: "preset", preset: id, orientation: landscape ? "landscape" : undefined });
        }}
      >
        <option value="">Responsive</option>
        {CATEGORIES.map((c) => (
          <optgroup key={c} label={c}>
            {BROWSER_PRESETS.filter((p) => p.category === c).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <SizeInput label="Width" value={viewport.width} onCommit={(w) => setSize(w, viewport.height)} />
      <span className="text-muted-foreground">×</span>
      <SizeInput label="Height" value={viewport.height} onCommit={(h) => setSize(viewport.width, h)} />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rotate"
        title="Rotate"
        onClick={() =>
          preset
            ? send({ t: "viewport", mode: "preset", preset: preset.id, orientation: landscape ? "portrait" : "landscape" })
            : setSize(viewport.height, viewport.width)
        }
      >
        <RotateCcwSquareIcon />
      </Button>
      {scale < 1 && <span className="font-mono text-muted-foreground tabular-nums">{Math.round(scale * 100)}%</span>}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Fill the panel"
        title="Fill the panel"
        onClick={() => send({ t: "viewport", mode: "fill" })}
      >
        <XIcon />
      </Button>
    </div>
  );
}

function SizeInput({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (Number.isFinite(n) && n >= 200) onCommit(Math.min(n, 3840));
    else setDraft(String(value));
  };
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(String(value));
          e.currentTarget.blur();
        }
      }}
      className="h-6 w-12 rounded-sm border bg-background px-1 text-center font-mono text-xs tabular-nums outline-none focus:border-ring"
    />
  );
}
