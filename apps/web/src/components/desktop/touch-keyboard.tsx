import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, ChevronDownIcon } from "lucide-react";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { EVDEV, KEY_LEFTMETA } from "@/lib/desktop/keycodes";
import { key, text } from "@/lib/desktop/protocol";
import { cn } from "@/lib/utils";

/** The evdev code of a KeyboardEvent.code that's in the table. */
const ev = (code: string): number => EVDEV[code] ?? 0;

type Modifier = "ctrl" | "alt" | "shift" | "super";

const MODIFIER_CODES: Record<Modifier, number> = {
  ctrl: ev("ControlLeft"),
  alt: ev("AltLeft"),
  shift: ev("ShiftLeft"),
  super: KEY_LEFTMETA,
};

// Characters a held modifier can combine with, by the key that types them on a
// US layout (Ctrl+C is the C key whatever the host's layout prints on it).
const CHAR_KEYS: Record<string, number> = {
  " ": ev("Space"), "-": ev("Minus"), "=": ev("Equal"), "[": ev("BracketLeft"), "]": ev("BracketRight"),
  ";": ev("Semicolon"), "'": ev("Quote"), "`": ev("Backquote"), "\\": ev("Backslash"), ",": ev("Comma"),
  ".": ev("Period"), "/": ev("Slash"),
};
for (const c of "abcdefghijklmnopqrstuvwxyz") CHAR_KEYS[c] = ev(`Key${c.toUpperCase()}`);
for (const c of "0123456789") CHAR_KEYS[c] = ev(`Digit${c}`);

// Keys the soft keyboard sends as real key events rather than text.
const DOM_KEYS: Record<string, number> = {
  Enter: ev("Enter"), Tab: ev("Tab"), Escape: ev("Escape"),
  ArrowUp: ev("ArrowUp"), ArrowDown: ev("ArrowDown"), ArrowLeft: ev("ArrowLeft"), ArrowRight: ev("ArrowRight"),
};

/**
 * What the hidden input holds between edits. Keyboards only report Backspace
 * as an edit, so there must be something to delete.
 */
const SENTINEL = " ";

/**
 * Typing on a phone: a hidden input brings up the soft keyboard, and its edits
 * go to the host as text and Backspaces. A bar above the keyboard adds the keys
 * phones don't have; a modifier there holds for the next key.
 */
export function useTouchKeyboard(send: (msg: ArrayBuffer) => void) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [mods, setMods] = useState<ReadonlySet<Modifier>>(new Set());
  const modsRef = useRef(mods);
  modsRef.current = mods;

  /** Presses and releases a key, with any held modifiers; then lets them go. */
  const tap = (code: number, extra: number[] = []) => {
    const held = [...[...modsRef.current].map((m) => MODIFIER_CODES[m]), ...extra];
    for (const h of held) send(key(h, true));
    send(key(code, true));
    send(key(code, false));
    for (const h of held.reverse()) send(key(h, false));
    if (modsRef.current.size) setMods((modsRef.current = new Set()));
  };

  const type = (s: string) => {
    if (!s) return;
    if (modsRef.current.size) {
      // The first character goes with the held modifiers, as a key.
      const first = [...s][0] ?? "";
      const code = CHAR_KEYS[first.toLowerCase()];
      if (code !== undefined) {
        tap(code, first !== first.toLowerCase() ? [ev("ShiftLeft")] : []);
        s = s.slice(first.length);
      }
    }
    for (const m of text(s)) send(m);
  };

  const focus = () => inputRef.current?.focus({ preventScroll: true });

  const close = () => {
    inputRef.current?.blur();
    setOpen(false);
    setMods(new Set());
  };

  /** The toolbar button: opens the keyboard, brings it back, or closes it. */
  const toggle = () => {
    if (open && document.activeElement === inputRef.current) close();
    else {
      focus();
      setOpen(true);
    }
  };

  return { inputRef, open, focus, toggle, close, mods, setMods, tap, type };
}

export type TouchKeyboard = ReturnType<typeof useTouchKeyboard>;

/** The hidden input; always rendered, so a tap can focus it synchronously (iOS shows the keyboard only then). */
export function TouchKeyboardInput({ kb }: { kb: TouchKeyboard }) {
  const last = useRef(SENTINEL);
  const composing = useRef(false);

  const reset = (input: HTMLInputElement) => {
    input.value = SENTINEL;
    last.current = SENTINEL;
    input.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };

  return (
    <input
      ref={kb.inputRef as RefObject<HTMLInputElement>}
      data-local-keys
      aria-label="Type on the remote desktop"
      defaultValue={SENTINEL}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      enterKeyHint="enter"
      // 16px keeps iOS from zooming in on focus.
      className="pointer-events-none absolute bottom-0 left-0 size-px text-base opacity-0"
      onFocus={(e) => reset(e.currentTarget)}
      onKeyDown={(e) => {
        const code = DOM_KEYS[e.key];
        if (code === undefined || e.nativeEvent.isComposing) return;
        e.preventDefault();
        kb.tap(code);
      }}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={(e) => {
        composing.current = false;
        reset(e.currentTarget);
      }}
      onInput={(e) => {
        const input = e.currentTarget;
        const prev = last.current;
        const next = input.value;
        let i = 0;
        while (i < prev.length && i < next.length && prev[i] === next[i]) i++;
        if (i > 0 && isHighSurrogate(prev.charCodeAt(i - 1))) i--; // don't split a surrogate pair
        const removed = [...prev.slice(i)].length;
        for (let n = 0; n < removed; n++) kb.tap(ev("Backspace"));
        kb.type(next.slice(i));
        last.current = next;
        if (!composing.current) reset(input);
      }}
    />
  );
}

/** Keys a phone keyboard lacks, above it while it's open. */
export function TouchKeyboardBar({ kb }: { kb: TouchKeyboard }) {
  if (!kb.open) return null;
  const toggleMod = (m: Modifier) =>
    kb.setMods((s) => {
      const next = new Set(s);
      if (!next.delete(m)) next.add(m);
      return next;
    });
  return (
    <div
      data-local-keys
      className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-1 border-t bg-sidebar/95 px-1.5 py-1 backdrop-blur"
      // Taps here must leave focus (and so the keyboard) on the input.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <BarKey label="Esc" onPress={() => kb.tap(ev("Escape"))} />
        <BarKey label="Tab" onPress={() => kb.tap(ev("Tab"))} />
        <BarKey label="Ctrl" active={kb.mods.has("ctrl")} onPress={() => toggleMod("ctrl")} />
        <BarKey label="Alt" active={kb.mods.has("alt")} onPress={() => toggleMod("alt")} />
        <BarKey label="Shift" active={kb.mods.has("shift")} onPress={() => toggleMod("shift")} />
        <BarKey label="Super" title="Super (the Windows key)" active={kb.mods.has("super")} onPress={() => toggleMod("super")} />
        <BarKey label={<ArrowLeftIcon />} title="Left" onPress={() => kb.tap(ev("ArrowLeft"))} />
        <BarKey label={<ArrowUpIcon />} title="Up" onPress={() => kb.tap(ev("ArrowUp"))} />
        <BarKey label={<ArrowDownIcon />} title="Down" onPress={() => kb.tap(ev("ArrowDown"))} />
        <BarKey label={<ArrowRightIcon />} title="Right" onPress={() => kb.tap(ev("ArrowRight"))} />
        <BarKey label="Home" onPress={() => kb.tap(ev("Home"))} />
        <BarKey label="End" onPress={() => kb.tap(ev("End"))} />
        <BarKey label="PgUp" onPress={() => kb.tap(ev("PageUp"))} />
        <BarKey label="PgDn" onPress={() => kb.tap(ev("PageDown"))} />
        <BarKey label="Del" onPress={() => kb.tap(ev("Delete"))} />
      </div>
      <BarKey label={<ChevronDownIcon />} title="Hide keyboard" onPress={kb.close} />
    </div>
  );
}

function BarKey({
  label,
  title,
  active,
  onPress,
}: {
  label: ReactNode;
  title?: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        "flex h-9 min-w-10 shrink-0 items-center justify-center rounded-md px-2 text-xs font-medium [&_svg]:size-4",
        active ? "bg-primary text-primary-foreground" : "bg-muted text-foreground active:bg-accent",
      )}
      onClick={onPress}
    >
      {label}
    </button>
  );
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
