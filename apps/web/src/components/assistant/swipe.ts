// Swiping something away on a touch screen: it follows the finger in the
// directions given and goes once dragged far enough. The element needs a
// touch-action that leaves those directions to the page's script (touch-none
// for every direction, touch-pan-y for sideways only).

import { type CSSProperties, type PointerEvent, useRef, useState } from "react";

export type SwipeDir = "left" | "right" | "up" | "down";

/** A swipe this far dismisses. */
const AWAY_PX = 80;
/** Past this it's a swipe, not a tap. */
const MOVED_PX = 10;

export function useSwipeAway(onAway: () => void, dirs: SwipeDir[]) {
  const [off, setOff] = useState({ x: 0, y: 0 });
  const start = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const reset = () => {
    start.current = null;
    setOff({ x: 0, y: 0 });
  };
  const dist = Math.hypot(off.x, off.y);
  const style: CSSProperties | undefined = dist
    ? { transform: `translate(${off.x}px, ${off.y}px)`, opacity: Math.max(0.2, 1 - dist / 300), transition: "none" }
    : undefined;
  return {
    /** Whether the last touch was a swipe, so its click doesn't count as a tap. */
    swiped: () => moved.current,
    style,
    handlers: {
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (e.pointerType === "mouse") return;
        const hit = (e.target as HTMLElement).closest("button,a,input,textarea");
        if (hit && hit !== e.currentTarget) return;
        start.current = { x: e.clientX, y: e.clientY };
        moved.current = false;
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        if (!start.current) return;
        const dx = e.clientX - start.current.x;
        const dy = e.clientY - start.current.y;
        const x = (dx > 0 && dirs.includes("right")) || (dx < 0 && dirs.includes("left")) ? dx : 0;
        const y = (dy > 0 && dirs.includes("down")) || (dy < 0 && dirs.includes("up")) ? dy : 0;
        if (!moved.current && Math.hypot(x, y) > MOVED_PX) {
          moved.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }
        setOff({ x, y });
      },
      onPointerUp: () => {
        if (start.current && dist > AWAY_PX) onAway();
        reset();
      },
      onPointerCancel: reset,
    },
  };
}
