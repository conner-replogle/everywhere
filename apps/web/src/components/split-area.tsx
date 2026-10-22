import { type HTMLAttributes, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Where a mounted pane is: one of the two shown, or kept hidden. */
export type PaneSide = "primary" | "split" | "hidden";

export interface SplitItem {
  id: string;
  side: PaneSide;
  node: ReactNode;
  /** More props for the pane's wrapper (input capture, role…). */
  props?: HTMLAttributes<HTMLDivElement>;
}

const RATIO_KEY = "everywhere.splitRatio";
const MIN = 0.2;
const MAX = 0.8;
/** Below this width, the panes stack. */
const STACK_BELOW = 720;

const valid = (r: number | undefined): r is number => r !== undefined && r >= MIN && r <= MAX;

/** The divider last set anywhere, for threads without their own. */
function savedRatio(): number {
  try {
    const r = Number(localStorage.getItem(RATIO_KEY));
    return valid(r) ? r : 0.5;
  } catch {
    return 0.5;
  }
}

/**
 * A thread's panes, one shown or two side by side (stacked when narrow),
 * with a divider to drag between them. Every pane stays in one container
 * and is only positioned, so moving one between sides never remounts it
 * (a terminal keeps its scrollback, a claude tab its draft); hidden ones
 * keep the full size, so terminals don't resize.
 */
export function SplitArea({
  items,
  split,
  focused,
  onFocus,
  initialRatio,
  onRatio,
}: {
  items: SplitItem[];
  /** Two panes are shown. */
  split: boolean;
  focused: "primary" | "split";
  onFocus: (side: "primary" | "split") => void;
  /** The divider's start, as the primary pane's share (the last one set anywhere if absent). */
  initialRatio?: number;
  onRatio?: (ratio: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(() => (valid(initialRatio) ? initialRatio : savedRatio()));
  const [dragging, setDragging] = useState(false);
  // The drag as it goes, ahead of a render.
  const live = useRef({ dragging: false, ratio });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const stacked = width > 0 && width < STACK_BELOW;
  const pct = `${ratio * 100}%`;
  const rest = `${(1 - ratio) * 100}%`;

  const place = (side: PaneSide): React.CSSProperties => {
    if (!split || side === "hidden") return { inset: 0 };
    if (side === "primary") return stacked ? { left: 0, right: 0, top: 0, height: pct } : { top: 0, bottom: 0, left: 0, width: pct };
    return stacked ? { left: 0, right: 0, bottom: 0, height: rest } : { top: 0, bottom: 0, right: 0, width: rest };
  };

  const save = (r: number) => {
    onRatio?.(r);
    try {
      localStorage.setItem(RATIO_KEY, String(r));
    } catch {
      // Remembered for the page only.
    }
  };
  const drag = (e: React.PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const r = stacked ? (e.clientY - box.top) / box.height : (e.clientX - box.left) / box.width;
    live.current.ratio = Math.min(MAX, Math.max(MIN, r));
    setRatio(live.current.ratio);
  };
  // Kept once a drag ends.
  const endDrag = () => {
    if (!live.current.dragging) return;
    live.current.dragging = false;
    setDragging(false);
    save(live.current.ratio);
  };

  return (
    <div ref={ref} className="relative min-h-0 flex-1">
      {items.map((it) => {
        const shown = it.side !== "hidden";
        const side = it.side === "split" ? "split" : "primary";
        return (
          <div
            key={it.id}
            {...it.props}
            onPointerDownCapture={(e) => {
              if (shown && split) onFocus(side);
              it.props?.onPointerDownCapture?.(e);
            }}
            onFocusCapture={(e) => {
              if (shown && split) onFocus(side);
              it.props?.onFocusCapture?.(e);
            }}
            // A container: views lay out by the pane's width, not the window's.
            className={cn("@container absolute overflow-hidden", !shown && "invisible", it.props?.className)}
            style={place(it.side)}
          >
            {it.node}
            {split && shown && focused === side && (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 bg-primary/70" aria-hidden />
            )}
          </div>
        );
      })}
      {split && (
        <div
          role="separator"
          aria-orientation={stacked ? "horizontal" : "vertical"}
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={MIN * 100}
          aria-valuemax={MAX * 100}
          title="Drag to resize; double-click to split evenly"
          className={cn(
            "group absolute z-20 flex touch-none items-center justify-center",
            stacked ? "inset-x-0 h-3 -translate-y-1/2 cursor-row-resize" : "inset-y-0 w-3 -translate-x-1/2 cursor-col-resize",
          )}
          style={stacked ? { top: pct } : { left: pct }}
          onPointerDown={(e) => {
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // No such pointer (a synthetic event): the overlay still follows it.
            }
            live.current = { dragging: true, ratio };
            setDragging(true);
          }}
          onPointerMove={(e) => live.current.dragging && drag(e)}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => (setRatio(0.5), save(0.5))}
        >
          <div
            className={cn(
              "bg-border transition-colors group-hover:bg-primary/60",
              dragging && "bg-primary/60",
              stacked ? "h-px w-full" : "h-full w-px",
            )}
          />
        </div>
      )}
      {/* Frames (web pages, dashboards, the desktop) would take the pointer mid-drag. */}
      {dragging && <div className={cn("absolute inset-0 z-10", stacked ? "cursor-row-resize" : "cursor-col-resize")} />}
    </div>
  );
}
