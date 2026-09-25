import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

// The keys a phone's keyboard lacks, in a row under the terminal. Ctrl and Alt
// are sticky: tap one, then a key (on the row or the keyboard).

export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
}

const coarse = typeof window !== "undefined" ? window.matchMedia("(pointer: coarse)") : null;

/** True on touch-first devices, where the row is shown. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    (fn) => {
      coarse?.addEventListener("change", fn);
      return () => coarse?.removeEventListener("change", fn);
    },
    () => !!coarse?.matches,
  );
}

type Arrow = "A" | "B" | "C" | "D"; // up, down, right, left

/** An arrow key's sequence, with xterm's modifier parameter when Ctrl or Alt is held. */
export function arrowSequence(dir: Arrow, mods: Modifiers, applicationCursor: boolean): string {
  const param = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
  if (param > 1) return `\x1b[1;${param}${dir}`;
  return applicationCursor ? `\x1bO${dir}` : `\x1b[${dir}`;
}

/** Applies held modifiers to one typed character: Ctrl+letter is its control code, Alt prefixes ESC. */
export function applyModifiers(data: string, mods: Modifiers): string {
  let out = data;
  if (mods.ctrl && data.length === 1) {
    const c = data.toUpperCase().charCodeAt(0);
    if (data === " " || data === "@") out = "\x00";
    else if (c >= 0x41 && c <= 0x5f) out = String.fromCharCode(c & 0x1f); // A-Z [ \ ] ^ _
    else if (data === "?") out = "\x7f";
  }
  if (mods.alt) out = `\x1b${out}`;
  return out;
}

export function TerminalKeys({
  mods,
  onToggle,
  onKeys,
  applicationCursor,
}: {
  mods: Modifiers;
  onToggle: (mod: keyof Modifiers) => void;
  /** Sends a sequence; the held modifiers are then released. */
  onKeys: (data: string) => void;
  applicationCursor: () => boolean;
}) {
  const arrow = (dir: Arrow) => () => onKeys(arrowSequence(dir, mods, applicationCursor()));
  const text = (s: string) => () => onKeys(applyModifiers(s, mods));
  return (
    <div
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-t bg-sidebar px-1.5 py-1 [scrollbar-width:none]"
      role="toolbar"
      aria-label="Terminal keys"
    >
      <Key label="Esc" onPress={() => onKeys("\x1b")} />
      <Key label="Tab" onPress={text("\t")} />
      <Key label="Ctrl" pressed={mods.ctrl} onPress={() => onToggle("ctrl")} />
      <Key label="Alt" pressed={mods.alt} onPress={() => onToggle("alt")} />
      <Key label={<ArrowLeftIcon />} aria="Left" onPress={arrow("D")} />
      <Key label={<ArrowUpIcon />} aria="Up" onPress={arrow("A")} />
      <Key label={<ArrowDownIcon />} aria="Down" onPress={arrow("B")} />
      <Key label={<ArrowRightIcon />} aria="Right" onPress={arrow("C")} />
      {["|", "~", "/", "-", "`"].map((s) => (
        <Key key={s} label={s} onPress={text(s)} />
      ))}
    </div>
  );
}

function Key({
  label,
  aria,
  pressed,
  onPress,
}: {
  label: React.ReactNode;
  aria?: string;
  pressed?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={aria}
      aria-pressed={pressed}
      // Keep focus (and the soft keyboard) on the terminal.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
      className={cn(
        "flex h-8 min-w-10 shrink-0 items-center justify-center rounded-md border px-2.5 font-mono text-[13px] text-foreground select-none active:bg-accent [&_svg]:size-3.5",
        pressed ? "border-primary/60 bg-primary/15 text-primary" : "bg-background/60",
      )}
    >
      {label}
    </button>
  );
}
