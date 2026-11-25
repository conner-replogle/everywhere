import { viewerIsMac } from "../browser-input";
import type { DesktopConnection } from "./connection";
import { EVDEV, KEY_LEFTMETA } from "./keycodes";
import * as proto from "./protocol";

export interface InputOptions {
  /** KeyboardEvent.code that is sent to the host as Super, or null. */
  superSubstitute: string | null;
  /** Keys are forwarded while focus is inside this element. */
  keyTarget: HTMLElement;
}


/**
 * Chromium's pointerrawupdate comes as soon as the mouse moves, where
 * pointermove waits for the next frame: up to a frame less latency, and every
 * motion of a high-rate mouse, which a game reading it counts on.
 */
const RAW_MOTION = typeof window !== "undefined" && "onpointerrawupdate" in window;

/** Ctrl+Alt+Shift+Z (Moonlight's shortcut) lets the mouse go, or captures it again. */
const CAPTURE_COMBO = "KeyZ";

/**
 * Forwards pointer and keyboard events on the video element to the host.
 * Keys go by physical position (KeyboardEvent.code → evdev), so the host's
 * layout decides the character. Elements marked `data-local-keys` keep their keys.
 *
 * A mouse works as one plugged into the host: a click captures it (pointer
 * lock) and from then on its raw motion moves the host pointer, through the
 * host's own pointer speed and acceleration, and reaches games as a mouse's
 * would, on the desktop and in games alike. Esc, Ctrl+Alt+Shift+Z or leaving
 * the page lets it go. Touch, and browsers or hosts that can't do that,
 * point where they touch instead.
 */
export class InputForwarder {
  private seq = 0;
  /** Touches go to the Trackpad instead of pointing directly. */
  touchTrackpad = false;
  /** Nothing reaches the host: the Trackpad zooms the picture instead. */
  private viewOnly = false;
  /** The mouse is captured and sends motion; off, it points. */
  private relativeOn = false;
  private wasLocked = false;
  /** The host hid its pointer (a game reading the mouse's motion). */
  private hostHidden = false;
  /** The host moves its pointer by motion: buttons press where it is. Off after a position is sent. */
  private hostRelative = false;
  onLockChange?: (locked: boolean) => void;
  private pressedKeys = new Set<number>();
  private detach: (() => void)[] = [];

  constructor(
    private video: HTMLVideoElement,
    private conn: DesktopConnection,
    private opts: InputOptions,
  ) {
    // Touch stays on pointermove: the trackpad and direct touch go by frames.
    this.listen(video, "pointermove", (e) => (!RAW_MOTION || e.pointerType === "touch") && this.onMove(e));
    if (RAW_MOTION) {
      this.listen(video, "pointerrawupdate" as "pointermove", (e) => e.pointerType !== "touch" && this.onMove(e));
    }
    this.listen(video, "pointerdown", (e) => this.onButton(e, true));
    this.listen(video, "pointerup", (e) => this.onButton(e, false));
    this.listen(video, "pointercancel", () => this.releaseAll());
    this.listen(video, "contextmenu", (e) => e.preventDefault());
    this.listen(video, "wheel", (e) => this.onWheel(e), { passive: false });
    this.listen(opts.keyTarget, "keydown", (e) => this.onKey(e, true), { capture: true });
    this.listen(opts.keyTarget, "keyup", (e) => this.onKey(e, false), { capture: true });
    this.listen(opts.keyTarget, "focusout", () => this.releaseAll());
    this.listen(window, "blur", () => this.releaseAll());
    this.listen(document, "visibilitychange", () => document.hidden && this.releaseAll());
    this.listen(document, "pointerlockchange", () => this.onLockChanged());
  }

  private get locked() {
    return document.pointerLockElement === this.video;
  }

  setViewOnly(on: boolean) {
    if (on === this.viewOnly) return;
    this.viewOnly = on;
    if (on) {
      if (this.locked) document.exitPointerLock();
      this.releaseAll();
    }
  }

  /** The mouse is captured on a click and sends motion. Needs a fine pointer, pointer lock, and a host that takes moveBy. */
  get relative() {
    return this.relativeOn && !this.viewOnly;
  }

  setRelative(on: boolean) {
    this.relativeOn = on;
    if (!this.relative && this.locked) document.exitPointerLock();
  }

  /** The host pointer is hidden by a game (CursorPosition.captured), or not. */
  setHostCaptured(hidden: boolean) {
    this.hostHidden = hidden;
  }

  /** Captures the mouse. Needs a user gesture (a click or key press). */
  capture() {
    if (!this.relative || this.locked) return;
    // Raw mouse counts where the browser has them, as the host reads a mouse.
    const lock = (o?: PointerLockOptions) => Promise.resolve().then(() => this.video.requestPointerLock(o));
    void lock({ unadjustedMovement: true })
      .catch(() => lock())
      .catch(() => {});
  }

  release() {
    if (this.locked) document.exitPointerLock();
  }

  private onLockChanged() {
    const locked = this.locked;
    if (locked === this.wasLocked) return;
    this.wasLocked = locked;
    // Letting go lets go of everything; capturing keeps the capturing click held, for a drag.
    if (!locked) this.releaseAll();
    this.onLockChange?.(locked);
  }

  dispose() {
    if (this.locked) document.exitPointerLock();
    this.releaseAll();
    this.detach.forEach((f) => f());
    this.detach = [];
  }

  private listen<K extends keyof HTMLElementEventMap | "visibilitychange" | "pointerlockchange">(
    target: HTMLElement | Window | Document,
    type: K,
    fn: (e: K extends keyof HTMLElementEventMap ? HTMLElementEventMap[K] : Event) => void,
    opts?: AddEventListenerOptions,
  ) {
    const handler = ((e: Event) => {
      if (this.viewOnly && e.type !== "visibilitychange" && e.type !== "pointerlockchange" && e.type !== "blur" && e.type !== "focusout") {
        return;
      }
      fn(e as never);
    }) as EventListener;
    target.addEventListener(type, handler, opts);
    this.detach.push(() => target.removeEventListener(type, handler, opts));
  }

  private send(ch: RTCDataChannel, msg: ArrayBuffer) {
    if (ch.readyState === "open") ch.send(msg);
  }

  /** Maps a client position to 0..1 within the letterboxed video content. */
  private normalize(e: MouseEvent): [number, number] | null {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return null;
    const r = this.video.getBoundingClientRect();
    const scale = Math.min(r.width / vw, r.height / vh);
    const cw = vw * scale, ch = vh * scale;
    const x = (e.clientX - r.left - (r.width - cw) / 2) / cw;
    const y = (e.clientY - r.top - (r.height - ch) / 2) / ch;
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
  }

  /** Puts the host pointer at x, y (0..1 across the picture). */
  moveTo(x: number, y: number) {
    this.hostRelative = false;
    this.send(this.conn.input, proto.move(this.seq++, x, y));
  }

  /** Presses or releases a DOM-numbered button at x, y. */
  press(btn: number, pressed: boolean, x: number, y: number) {
    this.hostRelative = false;
    this.send(this.conn.control, proto.button(btn, pressed, x, y));
  }

  /** Moves the host pointer by dx, dy, as a mouse does. */
  private moveBy(dx: number, dy: number) {
    this.hostRelative = true;
    this.send(this.conn.control, proto.moveBy(dx, dy));
  }

  /** Presses or releases a button where the host pointer is. */
  private pressHere(btn: number, pressed: boolean) {
    // Motion first, even none: a button alone would carry a position.
    if (!this.hostRelative) this.moveBy(0, 0);
    this.send(this.conn.control, proto.button(btn, pressed, 0.5, 0.5));
  }

  /** Scrolls by pixels, like a touchpad. */
  scrollBy(dx: number, dy: number) {
    this.send(this.conn.control, proto.scroll(true, dx, dy));
  }

  private onMove(e: PointerEvent) {
    if (this.touchTrackpad && e.pointerType === "touch") return;
    if (this.locked) {
      // The mouse's own motion, as the host would read it from a mouse plugged into it.
      if (e.movementX || e.movementY) this.moveBy(e.movementX, e.movementY);
      return;
    }
    // Not captured yet: the host pointer stays where it is, as an untouched mouse leaves it.
    if (this.relative && e.pointerType === "mouse") return;
    const p = this.normalize(e);
    if (p) this.moveTo(p[0], p[1]);
  }

  private onButton(e: PointerEvent, pressed: boolean) {
    if (this.touchTrackpad && e.pointerType === "touch") return;
    if (this.locked) {
      e.preventDefault();
      this.pressHere(e.button, pressed);
      return;
    }
    if (this.relative && e.pointerType === "mouse") {
      e.preventDefault();
      if (pressed) this.capture();
      // The capturing click is a click too. On the desktop it lands where
      // it was clicked, the host pointer jumping there; a game hid its
      // pointer, so it gets the click where that is, with no jump.
      if (this.hostHidden) {
        this.pressHere(e.button, pressed);
        return;
      }
    }
    const p = this.normalize(e);
    if (!p) return;
    e.preventDefault();
    if (pressed && !this.relative) this.video.setPointerCapture(e.pointerId);
    this.press(e.button, pressed, p[0], p[1]);
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    let { deltaX: dx, deltaY: dy } = e;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      this.send(this.conn.control, proto.scroll(false, dx / 3, dy / 3));
    } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      this.send(this.conn.control, proto.scroll(false, dx * 10, dy * 10));
    } else if (isWheelNotch(dx) && isWheelNotch(dy)) {
      // Chromium reports physical wheel notches as multiples of 120 px.
      this.send(this.conn.control, proto.scroll(false, dx / 120, dy / 120));
    } else {
      this.send(this.conn.control, proto.scroll(true, dx, dy));
    }
  }

  private onKey(e: KeyboardEvent, pressed: boolean) {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("[data-local-keys]")) return;
    if (e.ctrlKey && e.altKey && e.shiftKey && e.code === CAPTURE_COMBO) {
      e.preventDefault();
      e.stopPropagation();
      if (!pressed || e.repeat) return;
      // Ctrl, Alt and Shift already went down on the host; let them go.
      this.releaseAll();
      if (this.locked) this.release();
      else this.capture();
      return;
    }
    const code = e.code === this.opts.superSubstitute ? KEY_LEFTMETA : EVDEV[e.code];
    if (code === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return; // the host application generates its own repeats
    if (pressed) this.pressedKeys.add(code);
    else this.pressedKeys.delete(code);
    this.send(this.conn.control, proto.key(code, pressed));

    // macOS browsers never fire keyup for a key pressed while ⌘ is down, so the
    // host would hold it (and repeat it) forever: tap it instead. Anything still
    // down when ⌘ comes up is released too.
    if (!viewerIsMac) return;
    const meta = e.code === "MetaLeft" || e.code === "MetaRight" || code === KEY_LEFTMETA;
    if (pressed && e.metaKey && !meta && !MODIFIERS.has(e.code)) {
      this.pressedKeys.delete(code);
      this.send(this.conn.control, proto.key(code, false));
    } else if (!pressed && meta) {
      for (const held of [...this.pressedKeys]) {
        if (MODIFIER_CODES.has(held)) continue;
        this.pressedKeys.delete(held);
        this.send(this.conn.control, proto.key(held, false));
      }
    }
  }

  releaseAll() {
    this.pressedKeys.clear();
    this.send(this.conn.control, proto.releaseAll());
  }
}

const MODIFIERS = new Set([
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock",
]);
const MODIFIER_CODES = new Set([...MODIFIERS].map((c) => EVDEV[c]));

function isWheelNotch(d: number): boolean {
  return d === 0 || (Number.isInteger(d) && d % 120 === 0);
}
