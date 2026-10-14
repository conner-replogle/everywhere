import type { CursorRenderer } from "./cursor";
import type { InputForwarder } from "./input";

/** A touch shorter than this that barely moved is a tap. */
const TAP_MS = 300;
/** How far (CSS px) a finger may wander and still be tapping or holding. */
const SLOP = 10;
/** Holding one finger still this long presses the left button, to drag. */
const HOLD_MS = 450;
/** Two fingers spreading or closing by this fraction is a pinch rather than a scroll. */
const PINCH_START = 0.1;
const MAX_ZOOM = 5;
/** Pointer travel per finger travel, as a share of the picture's width, before acceleration. */
const SPEED = 1;
const SCROLL_GAIN = 1.5;
/** The view pans to keep the pointer at least this far inside its edges. */
const FOLLOW_MARGIN = 48;
/** View only: a second tap this soon after a tap zooms in or back out. */
const DOUBLE_TAP_MS = 300;
/** View only: how far a double tap or double click zooms in. */
const TAP_ZOOM = 2.5;

type Mode = "move" | "drag" | "scroll" | "pinch" | "pan" | "done";

interface Point {
  x: number;
  y: number;
}

/**
 * Turns the picture into a laptop-style trackpad for touch screens: one
 * finger steers the pointer from wherever it is, a tap clicks, holding then
 * dragging drags, two fingers scroll or pinch-zoom the view, and a two- or
 * three-finger tap is a right or middle click. Mouse and pen input keep
 * pointing directly.
 *
 * View only, nothing reaches the desktop: fingers pinch to zoom and drag to
 * pan, a mouse wheels to zoom and drags to pan, and a double tap or click
 * zooms in or back out.
 */
export class Trackpad {
  private enabled = false;
  private view = false;
  private lastTap = 0;
  private dragging: Point | null = null;
  private pos: Point = { x: 0.5, y: 0.5 };
  private detach: (() => void)[] = [];

  // The current gesture: from the first finger down to the last one up.
  private mode: Mode | null = null;
  private start = 0;
  private fingers = 0;
  private moved = false;
  private origin: Point = { x: 0, y: 0 };
  private last: Point = { x: 0, y: 0 };
  private lastT = 0;
  private spread = 0;
  private baseSpread = 0;
  private baseCenter: Point = { x: 0, y: 0 };
  private hold: ReturnType<typeof setTimeout> | undefined;

  // The view's zoom: the picture scaled by `scale` and shifted by (tx, ty) CSS px.
  private scale = 1;
  private tx = 0;
  private ty = 0;

  constructor(
    private video: HTMLVideoElement,
    private stage: HTMLElement,
    private input: InputForwarder,
    private cursor: CursorRenderer,
  ) {
    const opts = { passive: false } as const;
    this.listen("touchstart", this.onStart, opts);
    this.listen("touchmove", this.onMove, opts);
    this.listen("touchend", this.onEnd, opts);
    this.listen("touchcancel", this.onCancel, opts);
    this.listenView("wheel", this.onWheel, opts);
    this.listenView("pointerdown", this.onPointerDown, opts);
    this.listenView("pointermove", this.onPointerMove, opts);
    this.listenView("pointerup", this.onPointerUp, opts);
    this.listenView("pointercancel", this.onPointerUp, opts);
    this.listenView("dblclick", this.onDoubleClick, opts);
    cursor.onHostMove = (p) => {
      if (this.mode !== "drag") this.pos = p;
    };
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.input.touchTrackpad = on;
    this.reset();
    if (this.view) return;
    if (on) {
      this.pos = this.cursor.hostPosition ?? this.pos;
      this.cursor.pin(this.pos);
    } else {
      this.cursor.pin(null);
      this.zoomTo(1, 0, 0);
    }
  }

  /** View only: input stops reaching the desktop, and touch and mouse zoom the picture instead. */
  setView(on: boolean) {
    if (on === this.view) return;
    this.view = on;
    this.input.setViewOnly(on);
    this.reset();
    this.dragging = null;
    if (on) {
      this.cursor.pin(null);
    } else {
      this.zoomTo(1, 0, 0);
      if (this.enabled) {
        this.pos = this.cursor.hostPosition ?? this.pos;
        this.cursor.pin(this.pos);
      }
    }
  }

  dispose() {
    this.setEnabled(false);
    this.cursor.onHostMove = undefined;
    this.detach.forEach((f) => f());
    this.detach = [];
  }

  private listen(type: "touchstart" | "touchmove" | "touchend" | "touchcancel", fn: (e: TouchEvent) => void, opts: AddEventListenerOptions) {
    const handler = (e: TouchEvent) => {
      if (!this.enabled && !this.view) return;
      e.preventDefault();
      fn.call(this, e);
    };
    this.video.addEventListener(type, handler, opts);
    this.detach.push(() => this.video.removeEventListener(type, handler, opts));
  }

  /** Listens only while view only. */
  private listenView<K extends "wheel" | "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "dblclick">(
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts: AddEventListenerOptions,
  ) {
    const handler = (e: HTMLElementEventMap[K]) => {
      if (this.view) fn.call(this, e);
    };
    this.video.addEventListener(type, handler, opts);
    this.detach.push(() => this.video.removeEventListener(type, handler, opts));
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const dy = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? e.deltaY : e.deltaY * 40;
    this.zoomAt(this.scale * Math.exp(-dy * 0.002), e.clientX, e.clientY);
  }

  private onPointerDown(e: PointerEvent) {
    if (e.pointerType === "touch" || e.button !== 0) return;
    e.preventDefault();
    this.video.setPointerCapture(e.pointerId);
    this.dragging = { x: e.clientX, y: e.clientY };
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.dragging || e.pointerType === "touch") return;
    this.zoomTo(this.scale, this.tx + e.clientX - this.dragging.x, this.ty + e.clientY - this.dragging.y);
    this.dragging = { x: e.clientX, y: e.clientY };
  }

  private onPointerUp(e: PointerEvent) {
    if (e.pointerType !== "touch") this.dragging = null;
  }

  private onDoubleClick(e: MouseEvent) {
    e.preventDefault();
    this.toggleZoom(e.clientX, e.clientY);
  }

  /** Zooms in about a point of the screen, or back out to the whole picture. */
  private toggleZoom(x: number, y: number) {
    if (this.scale > 1) this.zoomTo(1, 0, 0);
    else this.zoomAt(TAP_ZOOM, x, y);
  }

  /** Zooms to `scale`, keeping the picture under a point of the screen where it is. */
  private zoomAt(scale: number, x: number, y: number) {
    const box = this.stage.getBoundingClientRect();
    const lx = x - box.left, ly = y - box.top;
    const next = clamp(scale, 1, MAX_ZOOM);
    const k = next / this.scale;
    this.zoomTo(next, lx - (lx - this.tx) * k, ly - (ly - this.ty) * k);
  }

  private onStart(e: TouchEvent) {
    const now = performance.now();
    if (e.touches.length === e.changedTouches.length) {
      // A new gesture.
      this.mode = null;
      this.start = now;
      this.fingers = 0;
      this.moved = false;
      this.origin = center(e.touches);
    }
    this.fingers = Math.max(this.fingers, e.touches.length);
    this.baseline(e.touches, now);
    clearTimeout(this.hold);
    if (this.view) {
      this.mode = e.touches.length > 1 ? "pinch" : this.mode === "pinch" ? "done" : "pan";
    } else if (e.touches.length === 1 && this.mode === null) {
      this.hold = setTimeout(() => {
        if (this.moved || this.fingers !== 1 || this.mode !== null) return;
        this.mode = "drag";
        this.input.press(0, true, this.pos.x, this.pos.y);
        this.cursor.setPressed(true);
        navigator.vibrate?.(10);
      }, HOLD_MS);
    } else if (this.mode === "move") {
      // A second finger while steering: decide afresh between scroll and pinch.
      this.mode = null;
    }
  }

  private onMove(e: TouchEvent) {
    const now = performance.now();
    const c = center(e.touches);
    const dx = c.x - this.last.x, dy = c.y - this.last.y;
    const dt = now - this.lastT;
    this.last = c;
    this.lastT = now;
    if (!this.moved && Math.hypot(c.x - this.origin.x, c.y - this.origin.y) > SLOP) {
      this.moved = true;
      clearTimeout(this.hold);
    }

    if (this.mode === "done") return;
    if (this.mode === "pan") {
      this.zoomTo(this.scale, this.tx + dx, this.ty + dy);
      return;
    }
    if (this.mode === "drag" || e.touches.length === 1) {
      if (this.mode === null && this.moved) this.mode = "move";
      if (this.mode === "move" || this.mode === "drag") this.steer(dx, dy, dt);
      return;
    }

    const s = spread(e.touches);
    if (this.mode === null) {
      if (Math.abs(s / this.baseSpread - 1) > PINCH_START) this.mode = "pinch";
      else if (Math.hypot(c.x - this.baseCenter.x, c.y - this.baseCenter.y) > SLOP) this.mode = "scroll";
      else return;
      this.moved = true;
      clearTimeout(this.hold);
    }
    if (this.mode === "scroll") {
      // Natural scrolling: the content follows the fingers.
      this.input.scrollBy(-dx * SCROLL_GAIN, -dy * SCROLL_GAIN);
    } else if (this.mode === "pinch" && this.spread > 0) {
      const box = this.stage.getBoundingClientRect();
      const lx = c.x - box.left, ly = c.y - box.top;
      const next = clamp(this.scale * (s / this.spread), 1, MAX_ZOOM);
      // Zoom about the fingers' midpoint, and pan with it.
      const k = next / this.scale;
      this.zoomTo(next, lx - (lx - dx - this.tx) * k, ly - (ly - dy - this.ty) * k);
    }
    this.spread = s;
  }

  private onEnd(e: TouchEvent) {
    if (e.touches.length > 0) {
      // Lifting some fingers: carry on dragging, but a scroll or pinch is over.
      if (this.mode === "scroll" || this.mode === "pinch") this.mode = "done";
      this.baseline(e.touches, performance.now());
      return;
    }
    clearTimeout(this.hold);
    if (this.view) {
      const now = performance.now();
      if (!this.moved && this.fingers === 1 && now - this.start < TAP_MS) {
        if (now - this.lastTap < DOUBLE_TAP_MS) {
          this.toggleZoom(this.last.x, this.last.y);
          this.lastTap = 0;
        } else this.lastTap = now;
      }
    } else if (this.mode === "drag") {
      this.input.press(0, false, this.pos.x, this.pos.y);
      this.cursor.setPressed(false);
    } else if (!this.moved && performance.now() - this.start < TAP_MS) {
      const button = this.fingers === 1 ? 0 : this.fingers === 2 ? 2 : 1;
      this.input.press(button, true, this.pos.x, this.pos.y);
      this.input.press(button, false, this.pos.x, this.pos.y);
    }
    if (this.scale < 1.05) this.zoomTo(1, 0, 0);
    this.mode = null;
  }

  private onCancel() {
    if (this.mode === "drag") this.input.press(0, false, this.pos.x, this.pos.y);
    this.reset();
  }

  private reset() {
    clearTimeout(this.hold);
    this.cursor.setPressed(false);
    this.mode = null;
  }

  /** Measures from the fingers now down, so adding or lifting one doesn't jump. */
  private baseline(touches: TouchList, now: number) {
    this.last = this.baseCenter = center(touches);
    this.lastT = now;
    this.spread = this.baseSpread = spread(touches);
  }

  /** Moves the pointer by a finger's travel, faster the quicker it goes. */
  private steer(dx: number, dy: number, dt: number) {
    const r = this.cursor.contentRect();
    if (!r) return;
    const v = Math.hypot(dx, dy) / Math.max(dt, 1); // px/ms
    const k = (SPEED * (1 + Math.min(2.5, Math.max(0, v - 0.15) * 2.2))) / r.width;
    // The same distance on screen either way, whatever the picture's shape.
    this.pos = { x: clamp(this.pos.x + dx * k), y: clamp(this.pos.y + (dy * k * r.width) / r.height) };
    this.input.moveTo(this.pos.x, this.pos.y);
    this.cursor.pin(this.pos);
    this.follow(r);
  }

  /** Pans a zoomed view so the pointer stays in sight. */
  private follow(r: { left: number; top: number; width: number; height: number }) {
    if (this.scale === 1) return;
    const box = this.stage.getBoundingClientRect();
    const px = r.left + this.pos.x * r.width, py = r.top + this.pos.y * r.height;
    const m = FOLLOW_MARGIN;
    const shiftX = Math.max(0, box.left + m - px) - Math.max(0, px - (box.right - m));
    const shiftY = Math.max(0, box.top + m - py) - Math.max(0, py - (box.bottom - m));
    if (shiftX || shiftY) this.zoomTo(this.scale, this.tx + shiftX, this.ty + shiftY);
  }

  private zoomTo(scale: number, tx: number, ty: number) {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    // The picture as object-contain lays it out before zooming (the whole box if unknown).
    const fit = vw && vh ? Math.min(w / vw, h / vh) : 0;
    this.scale = scale;
    this.tx = pan(tx, scale, w, fit ? vw * fit : w);
    this.ty = pan(ty, scale, h, fit ? vh * fit : h);
    const style = this.video.style;
    style.transformOrigin = "0 0";
    style.transform = scale === 1 ? "" : `translate(${this.tx}px, ${this.ty}px) scale(${scale})`;
    this.cursor.refresh();
  }
}

/**
 * Clamps a pan offset along one axis so the picture, `length` long and
 * centred in a stage `size` long, fills the stage rather than showing the
 * letterboxing around it; once it's smaller than the stage, it's centred.
 */
function pan(t: number, scale: number, size: number, length: number): number {
  const offset = (size - length) / 2;
  const shown = length * scale;
  if (shown <= size) return (size - shown) / 2 - offset * scale;
  return clamp(t, size - (offset + length) * scale, -offset * scale);
}

function center(touches: TouchList): Point {
  let x = 0, y = 0;
  for (const t of touches) {
    x += t.clientX;
    y += t.clientY;
  }
  const n = Math.max(1, touches.length);
  return { x: x / n, y: y / n };
}

/** The first two fingers' distance apart. */
function spread(touches: TouchList): number {
  const a = touches[0], b = touches[1];
  return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
}

function clamp(v: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, v));
}
