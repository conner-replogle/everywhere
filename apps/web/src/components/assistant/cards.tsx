// The cards the assistant puts on screen (lib/assistant/screen.ts): the same
// on every device, filling in as the reply writes them, gone once they're no
// longer in use. They fade in and out; dismissing one (× or a swipe) hides
// it in this tab until the assistant shows it again. While the agent reads a
// thread and nothing is up yet, a "Reading…" card holds the place.

import { XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@/components/agent/markdown";
import { Button } from "@/components/ui/button";
import { screenCards, type ScreenCard, withWriting } from "@/lib/assistant/screen";
import { useAssistantSync } from "@/lib/assistant/sync";
import { cn } from "@/lib/utils";

/** How long a card takes to fade out, before it's removed. */
const LEAVE_MS = 220;
/** A swipe this far dismisses. */
const SWIPE_PX = 90;

/** The cards to show: the log's, the ones being written, minus those dismissed here. */
export function useScreenCards(): { cards: ScreenCard[]; reading: string | null; dismiss: (c: ScreenCard) => void } {
  const { entries, live } = useAssistantSync();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const cards = useMemo(
    () => withWriting(screenCards(entries), live?.cards).filter((c) => !dismissed.has(`${c.id}:${c.seq}`)),
    [entries, live?.cards, dismissed],
  );
  // "Reading a thread fix flaky test" while nothing is on screen for it yet.
  const reading = !cards.length && live?.activity?.startsWith("Reading a thread") ? live.activity.slice("Reading a thread".length).trim() : null;
  const dismiss = (c: ScreenCard) => setDismissed((d) => new Set(d).add(`${c.id}:${c.seq}`));
  return { cards, reading, dismiss };
}

/** Keeps items that went away for a moment, marked leaving, so they can fade out. */
function usePresence<T>(items: T[], key: (t: T) => string): { item: T; leaving: boolean }[] {
  const [gone, setGone] = useState<ReadonlyMap<string, T>>(new Map());
  const last = useRef<Map<string, T>>(new Map());
  // One timer per item leaving, kept across re-renders (a streaming reply re-renders often).
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const keys = items.map(key).join("\n");
  useEffect(() => {
    const now = new Map(items.map((t) => [key(t), t]));
    const left = [...last.current].filter(([k]) => !now.has(k));
    last.current = now;
    for (const k of now.keys()) {
      clearTimeout(timers.current.get(k));
      timers.current.delete(k);
    }
    if (!left.length) return;
    setGone((g) => new Map([...g, ...left]));
    for (const [k] of left) {
      timers.current.set(
        k,
        setTimeout(() => {
          timers.current.delete(k);
          setGone((g) => new Map([...g].filter(([x]) => x !== k)));
        }, LEAVE_MS),
      );
    }
    // Keyed on who's there (keys), not on the array, which is new every render.
  }, [keys]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const here = new Set(items.map(key));
  return [
    ...items.map((item) => ({ item, leaving: false })),
    ...[...gone].filter(([k]) => !here.has(k)).map(([, item]) => ({ item, leaving: true })),
  ];
}

const keyOf = (c: ScreenCard) => c.id;

/** The stack of cards, newest first; at most `max` of them. */
export function CardStack({ max = 2, className, fill }: { max?: number; className?: string; fill?: boolean }) {
  const { cards, reading, dismiss } = useScreenCards();
  const shown = usePresence(cards.slice(0, max), keyOf);
  if (!shown.length && !reading) return null;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {reading && <ReadingCard what={reading} />}
      {shown.map(({ item, leaving }) => (
        <OverlayCard key={item.id} card={item} leaving={leaving} fill={fill} onDismiss={() => dismiss(item)} />
      ))}
    </div>
  );
}

function ReadingCard({ what }: { what: string }) {
  return (
    <section
      aria-label="The assistant is reading"
      className="rounded-xl border border-border bg-background/80 px-4 py-3 text-sm shadow-xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-200 motion-reduce:animate-none"
    >
      <p className="text-muted-foreground">
        Reading <span className="text-foreground">{what || "a thread"}</span>…
      </p>
      <div className="mt-2.5 space-y-1.5" aria-hidden>
        {[85, 70, 55].map((w) => (
          <div key={w} className="h-2 animate-pulse rounded bg-muted motion-reduce:animate-none" style={{ width: `${w}%` }} />
        ))}
      </div>
    </section>
  );
}

export function OverlayCard({
  card,
  leaving,
  fill,
  onDismiss,
}: {
  card: ScreenCard;
  leaving?: boolean;
  /** Take the space it's given (full screen on phones) rather than its compact size. */
  fill?: boolean;
  onDismiss: () => void;
}) {
  // A brief highlight when the card changes in place.
  const [flash, setFlash] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (card.seq === 0) return; // still being written: no flashing per word
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 600);
    return () => clearTimeout(t);
  }, [card.seq]);

  // Swipe aside (or down on a phone) to dismiss.
  const [drag, setDrag] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const axis = fill ? "y" : "x";
  return (
    <section
      aria-label="From the assistant"
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" || (e.target as HTMLElement).closest("button,a,input")) return;
        start.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const d = axis === "x" ? e.clientX - start.current.x : e.clientY - start.current.y;
        setDrag(Math.max(0, d));
      }}
      onPointerUp={() => {
        if (drag > SWIPE_PX) onDismiss();
        start.current = null;
        setDrag(0);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDrag(0);
      }}
      style={drag ? { transform: axis === "x" ? `translateX(${drag}px)` : `translateY(${drag}px)`, opacity: 1 - drag / 300 } : undefined}
      className={cn(
        "relative overflow-y-auto overscroll-contain rounded-xl border bg-background/85 px-4 py-3 text-[13px] shadow-xl backdrop-blur-md transition-[border-color,box-shadow] duration-500 touch-pan-y",
        fill ? "h-full" : "max-h-[min(26rem,50vh)]",
        flash ? "border-primary/60 shadow-primary/20" : "border-border",
        leaving
          ? "pointer-events-none animate-out fade-out zoom-out-95 slide-out-to-right-4 fill-mode-forwards duration-200 motion-reduce:hidden"
          : "animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none",
      )}
    >
      <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" onClick={onDismiss} aria-label="Dismiss this card">
        <XIcon />
      </Button>
      <CardMarkdown text={card.markdown} />
    </section>
  );
}

/** A card's markdown, compact: checklists without bullets, and mermaid blocks drawn. */
function CardMarkdown({ text }: { text: string }) {
  const parts = useMemo(() => splitDiagrams(text), [text]);
  return (
    <div
      className={cn(
        "pr-6 leading-snug [&_table]:text-xs",
        "[&_ul:has(>li>input[type=checkbox])]:list-none [&_ul:has(>li>input[type=checkbox])]:pl-0",
        "[&_input[type=checkbox]]:mr-2 [&_input[type=checkbox]]:align-[-2px] [&_input[type=checkbox]]:accent-primary",
      )}
    >
      {parts.map((p, i) => (p.diagram ? <Diagram key={i} code={p.text} /> : <Markdown key={i} text={p.text} />))}
    </div>
  );
}

/** Finished ```mermaid blocks come out as diagrams; an unfinished one (still streaming) stays text. */
export function splitDiagrams(text: string): { text: string; diagram: boolean }[] {
  const out: { text: string; diagram: boolean }[] = [];
  const re = /```mermaid[ \t]*\n([\s\S]*?)```/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), diagram: false });
    out.push({ text: m[1]!.trim(), diagram: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), diagram: false });
  return out.filter((p) => p.text.trim());
}

type Mermaid = typeof import("mermaid").default;
let mermaid: Promise<Mermaid> | null = null;
let diagrams = 0;

function loadMermaid(): Promise<Mermaid> {
  mermaid ??= import("mermaid").then(({ default: m }) => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark");
    m.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: "inherit" });
    return m;
  });
  return mermaid;
}

function Diagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadMermaid()
      .then((m) => m.render(`ew-diagram-${++diagrams}`, code))
      .then(
        (r) => live && setSvg(r.svg),
        () => live && setFailed(true),
      );
    return () => {
      live = false;
    };
  }, [code]);
  if (failed || !svg) return <Markdown text={`\`\`\`\n${code}\n\`\`\``} />;
  // securityLevel "strict": mermaid sanitizes what it draws.
  return <div className="my-2 flex justify-center [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}
