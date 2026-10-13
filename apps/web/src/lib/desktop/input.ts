import { viewerIsMac } from "../browser-input";
import type { DesktopConnection } from "./connection";
import type { CursorRenderer } from "./cursor";
import { EVDEV, KEY_LEFTMETA } from "./keycodes";
import * as proto from "./protocol";

export interface InputOptions {
  /** KeyboardEvent.code that is sent to the host as Super, or null. */
  superSubstitute: string | null;
  /** Keys are forwarded while focus is inside this element. */
  keyTarget: HTMLElement;
  /** Draws the pointer while the mouse is captured. */
  cursor: CursorRenderer;
}

/**
 * Forwards pointer and keyboard events on the video element to the host.
 * Keys go by physical position (KeyboardEvent.code → evdev), so the host's
 * layout decides the character. Elements marked `data-local-keys` keep their keys.
 */
export class InputForwarder {
  private seq = 0;
  /** Touches go to the Trackpad instead of pointing directly. */
  touchTrackpad = false;
  /** A click locks the mouse to the picture (pointer lock) until Esc: motion is relative and has no edges. */
  private captureMouse = false;
  /** Where the host pointer goes when the lock takes hold. */
  private lockStart: [number, number] = [0.5, 0.5];
  private wasLocked = false;
  /** The host takes relative motion: sent while the mouse is captured, for games. */
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

  setCaptureMouse(on: boolean) {
    this.captureMouse = on;
    if (!on && this.locked) document.exitPointerLock();
  }

  private onLockChanged() {
    const locked = this.locked;
    if (locked === this.wasLocked) return;
    this.wasLocked = locked;
    this.opts.cursor.followHost = locked && this.relativeMotion;
    if (locked) {
      const [x, y] = this.lockStart;
      this.opts.cursor.pin({ x, y });
    } else {
      this.opts.cursor.pin(null);
      this.releaseAll();
    }
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
    const handler = fn as EventListener;
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
      this.moveLocked(e);
      return;
    }
    const p = this.normalize(e);
    if (p) this.moveTo(p[0], p[1]);
  }

  /**
   * Moves the host pointer by the mouse's motion: as a mouse would on the host
   * when it can take that, otherwise at the picture's scale.
   */
  private moveLocked(e: MouseEvent) {
    if (this.relativeMotion) {
      if (e.movementX || e.movementY) this.send(this.conn.control, proto.moveBy(e.movementX, e.movementY));
      return;
    }
    const at = this.opts.cursor.pinnedAt;
    const r = this.opts.cursor.contentRect();
    if (!at || !r) return;
    const x = Math.max(0, Math.min(1, at.x + e.movementX / r.width));
    const y = Math.max(0, Math.min(1, at.y + e.movementY / r.height));
    this.opts.cursor.pin({ x, y });
    this.moveTo(x, y);
  }

  private onButton(e: PointerEvent, pressed: boolean) {
    if (this.touchTrackpad && e.pointerType === "touch") return;
    if (this.locked) {
      const at = this.opts.cursor.pinnedAt;
      if (!at) return;
      e.preventDefault();
      this.send(this.conn.control, proto.button(e.button, pressed, at.x, at.y));
      return;
    }
    const p = this.normalize(e);
    if (!p) return;
    e.preventDefault();
    if (pressed && this.captureMouse && !this.touchTrackpad && e.pointerType === "mouse") {
      this.lockStart = p;
      // Raw mouse counts where the browser has them, for games; rejected
      // without a user gesture or after a recent Esc, but the click still goes through.
      const lock = (o?: PointerLockOptions) => Promise.resolve(this.video.requestPointerLock(o));
      lock({ unadjustedMovement: true })
        .catch(() => lock())
        .catch(() => {});
    } else if (pressed) this.video.setPointerCapture(e.pointerId);
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
