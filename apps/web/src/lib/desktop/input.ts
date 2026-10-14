import { viewerIsMac } from "../browser-input";
import type { DesktopConnection } from "./connection";
import { GrabDetector } from "./grab";
import { EVDEV, KEY_LEFTMETA } from "./keycodes";
import * as proto from "./protocol";

export interface InputOptions {
  /** KeyboardEvent.code that is sent to the host as Super, or null. */
  superSubstitute: string | null;
  /** Keys are forwarded while focus is inside this element. */
  keyTarget: HTMLElement;
}

/** Once the mouse is captured, the host pointer going this far (0..1 of the picture) means the game let it go. */
const RELEASED = 0.03;
/** ...counting from where it settles this long after the capture. */
const SETTLE_MS = 300;

/**
 * Forwards pointer and keyboard events on the video element to the host.
 * Keys go by physical position (KeyboardEvent.code → evdev), so the host's
 * layout decides the character. Elements marked `data-local-keys` keep their keys.
 *
 * The mouse follows the host, as game streaming does: while an app there
 * (a game) has grabbed the pointer, a click captures the mouse (pointer lock)
 * and sends its motion rather than positions, until Esc or the app lets go.
 */
export class InputForwarder {
  private seq = 0;
  /** Touches go to the Trackpad instead of pointing directly. */
  touchTrackpad = false;
  /** Nothing reaches the host: the Trackpad zooms the picture instead. */
  private viewOnly = false;
  /** Tells when an app on the host has grabbed the pointer. */
  readonly grab = new GrabDetector();
  /** Where the click that captured the mouse was, sent with its buttons. */
  private lockAt: [number, number] = [0.5, 0.5];
  private lockedSince = 0;
  /** Where the host pointer settled after the capture. */
  private lockAnchor: { x: number; y: number } | null = null;
  private wasLocked = false;
  /** The host takes relative motion, so the mouse can be captured for a game. */
  relativeMotion = false;
  onLockChange?: (locked: boolean) => void;
  private pressedKeys = new Set<number>();
  private detach: (() => void)[] = [];

  constructor(
    private video: HTMLVideoElement,
    private conn: DesktopConnection,
    private opts: InputOptions,
  ) {
    this.listen(video, "pointermove", (e) => this.onMove(e));
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

  /** Where the host says its pointer is: whether the game has it, or let it go. */
  hostPosition(pos: { inside: boolean; x: number; y: number }) {
    const at = pos.inside ? { x: pos.x, y: pos.y } : null;
    this.grab.hostAt(at);
    if (!this.locked || !at) return;
    if (!this.lockAnchor || performance.now() - this.lockedSince < SETTLE_MS) this.lockAnchor = at;
    else if (Math.hypot(at.x - this.lockAnchor.x, at.y - this.lockAnchor.y) > RELEASED) {
      // It follows the mouse's motion: the game let go (a menu, or it lost focus).
      this.grab.reset();
      document.exitPointerLock();
    }
  }

  /** Captures the mouse for a game, from a click. */
  private capture(at: [number, number]) {
    this.lockAt = at;
    // Raw mouse counts where the browser has them; rejected without a user
    // gesture or after a recent Esc, but the click still goes through.
    const lock = (o?: PointerLockOptions) => Promise.resolve(this.video.requestPointerLock(o));
    lock({ unadjustedMovement: true })
      .catch(() => lock())
      .catch(() => {});
  }

  private onLockChanged() {
    const locked = this.locked;
    if (locked === this.wasLocked) return;
    this.wasLocked = locked;
    this.lockedSince = performance.now();
    this.lockAnchor = null;
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
    this.send(this.conn.input, proto.move(this.seq++, x, y));
    this.grab.sentMove(x, y, performance.now());
  }

  /** Presses or releases a DOM-numbered button at x, y. */
  press(btn: number, pressed: boolean, x: number, y: number) {
    this.send(this.conn.control, proto.button(btn, pressed, x, y));
  }

  /** Scrolls by pixels, like a touchpad. */
  scrollBy(dx: number, dy: number) {
    this.send(this.conn.control, proto.scroll(true, dx, dy));
  }

  private onMove(e: PointerEvent) {
    if (this.touchTrackpad && e.pointerType === "touch") return;
    if (this.locked) {
      // The mouse's own motion, as the game would read it from a mouse on the host.
      if (e.movementX || e.movementY) this.send(this.conn.control, proto.moveBy(e.movementX, e.movementY));
      return;
    }
    const p = this.normalize(e);
    if (p) this.moveTo(p[0], p[1]);
  }

  private onButton(e: PointerEvent, pressed: boolean) {
    if (this.touchTrackpad && e.pointerType === "touch") return;
    if (this.locked) {
      // The host presses where its pointer is, after motion.
      e.preventDefault();
      this.send(this.conn.control, proto.button(e.button, pressed, this.lockAt[0], this.lockAt[1]));
      return;
    }
    const p = this.normalize(e);
    if (!p) return;
    e.preventDefault();
    if (pressed && this.grab.grabbed && this.relativeMotion && e.pointerType === "mouse") this.capture(p);
    else if (pressed) this.video.setPointerCapture(e.pointerId);
    this.send(this.conn.control, proto.button(e.button, pressed, p[0], p[1]));
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
