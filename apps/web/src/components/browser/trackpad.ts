// Mouse mode for touch screens: the screen works like a laptop trackpad
// driving a pointer drawn over the page, so the page sees a real mouse that
// hovers. One finger moves the pointer, a tap clicks where it is, a hold
// then drag drags, two fingers scroll, and a two-finger tap right-clicks.

import type { BrowserClientMsg } from "@everywhere/protocol";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";

const TAP_MS = 250;
const HOLD_MS = 400;
const SLOP_PX = 8;
const DOUBLE_TAP_MS = 400;
/** Pointer travel per finger travel, in page pixels per screen pixel of the picture. */
const GAIN = 1.5;

interface Finger {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

type Gesture = "none" | "move" | "drag" | "scroll";

export interface Trackpad {
  /** The pointer, in page CSS pixels. */
  pos: { x: number; y: number };
  /** A button is held (hold-then-drag). */
  dragging: boolean;
  onPointerDown(e: ReactPointerEvent): void;
  onPointerMove(e: ReactPointerEvent): void;
  onPointerUp(e: ReactPointerEvent): void;
  onPointerCancel(e: ReactPointerEvent): void;
}

export function useTrackpad({
  enabled,
  send,
  pageSize,
  screenPerPage,
}: {
  enabled: boolean;
  send: (msg: BrowserClientMsg) => void;
  /** The page's size in CSS pixels. */
  pageSize: () => { width: number; height: number };
  /** Screen pixels per page CSS pixel, as the picture is shown. */
  screenPerPage: () => number;
}): Trackpad {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const posRef = useRef(pos);
  const fingers = useRef(new Map<number, Finger>());
  const gesture = useRef<{ kind: Gesture; at: number; moved: boolean; maxFingers: number }>({
    kind: "none",
    at: 0,
    moved: false,
    maxFingers: 0,
  });
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastTap = useRef({ at: 0, count: 0 });

  const place = useCallback((x: number, y: number) => {
    const { width, height } = pageSize();
    const p = { x: Math.min(Math.max(x, 0), Math.max(width - 1, 0)), y: Math.min(Math.max(y, 0), Math.max(height - 1, 0)) };
    posRef.current = p;
    setPos(p);
    return p;
  }, [pageSize]);

  // Start in the middle of the page.
  useEffect(() => {
    if (!enabled) return;
    const { width, height } = pageSize();
    place(width / 2, height / 2);
    send({ t: "mouse", kind: "move", ...posRef.current });
  }, [enabled, pageSize, place, send]);

  const release = useCallback(() => {
    clearTimeout(hold.current);
    if (gesture.current.kind === "drag") {
      send({ t: "mouse", kind: "up", ...posRef.current, button: 0, buttons: 0, clickCount: 1 });
      setDragging(false);
    }
  }, [send]);

  useEffect(() => () => clearTimeout(hold.current), []);
  useEffect(() => {
    if (!enabled) {
      release();
      fingers.current.clear();
      gesture.current.kind = "none";
    }
  }, [enabled, release]);

  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // the pointer is already gone
    }
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
    const g = gesture.current;
    const n = fingers.current.size;
    if (n === 1) {
      gesture.current = { kind: "move", at: e.timeStamp, moved: false, maxFingers: 1 };
      clearTimeout(hold.current);
      hold.current = setTimeout(() => {
        const g = gesture.current;
        if (g.kind !== "move" || g.moved || fingers.current.size !== 1) return;
        g.kind = "drag";
        setDragging(true);
        navigator.vibrate?.(10);
        send({ t: "mouse", kind: "down", ...posRef.current, button: 0, buttons: 1, clickCount: 1 });
      }, HOLD_MS);
    } else {
      release();
      g.kind = "scroll";
      g.maxFingers = Math.max(g.maxFingers, n);
    }
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const f = fingers.current.get(e.pointerId);
    if (!f) return;
    const dx = e.clientX - f.x;
    const dy = e.clientY - f.y;
    f.x = e.clientX;
    f.y = e.clientY;
    const g = gesture.current;
    if (Math.hypot(e.clientX - f.startX, e.clientY - f.startY) > SLOP_PX) g.moved = true;
    const k = screenPerPage() || 1;
    if (g.kind === "scroll") {
      // Content follows the fingers, as it would under them. Each finger's
      // move is half the scroll, so two fingers moving together add up.
      const share = 1 / fingers.current.size;
      if (g.moved) send({ t: "mouse", kind: "wheel", ...posRef.current, deltaX: (-dx / k) * share, deltaY: (-dy / k) * share });
      return;
    }
    if (g.kind !== "move" && g.kind !== "drag") return;
    if (!g.moved && g.kind === "move") return; // might still be a tap or a hold
    const p = place(posRef.current.x + (dx / k) * GAIN, posRef.current.y + (dy / k) * GAIN);
    send({ t: "mouse", kind: "move", ...p, buttons: g.kind === "drag" ? 1 : 0 });
  };

  const end = (e: ReactPointerEvent, cancelled: boolean) => {
    if (!fingers.current.delete(e.pointerId)) return;
    if (fingers.current.size > 0) return;
    const g = gesture.current;
    clearTimeout(hold.current);
    const quick = e.timeStamp - g.at < TAP_MS && !g.moved && !cancelled;
    if (g.kind === "drag") {
      release();
    } else if (quick && g.kind === "move") {
      const t = lastTap.current;
      const count = e.timeStamp - t.at < DOUBLE_TAP_MS ? t.count + 1 : 1;
      lastTap.current = { at: e.timeStamp, count };
      const p = posRef.current;
      send({ t: "mouse", kind: "down", ...p, button: 0, buttons: 1, clickCount: count });
      send({ t: "mouse", kind: "up", ...p, button: 0, buttons: 0, clickCount: count });
    } else if (quick && g.kind === "scroll" && g.maxFingers === 2) {
      const p = posRef.current;
      send({ t: "mouse", kind: "down", ...p, button: 2, buttons: 2, clickCount: 1 });
      send({ t: "mouse", kind: "up", ...p, button: 2, buttons: 0, clickCount: 1 });
    }
    gesture.current = { kind: "none", at: 0, moved: false, maxFingers: 0 };
  };

  return {
    pos,
    dragging,
    onPointerDown,
    onPointerMove,
    onPointerUp: (e) => end(e, false),
    onPointerCancel: (e) => end(e, true),
  };
}
