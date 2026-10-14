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
 * How the mouse drives the host pointer, as in Moonlight: "desktop" sends
 * where it points (absolute); "game" captures it with a click and sends its
 * motion (relative), which is what games that grab the pointer read.
 */
export type MouseMode = "desktop" | "game";

/** Local shortcuts, with Ctrl+Alt+Shift (Moonlight's): release or capture the mouse, and switch modes. */
export type MouseCombo = "capture" | "mode";
const COMBOS: Record<string, MouseCombo> = { KeyZ: "capture", KeyM: "mode" };

/**
 * Forwards pointer and keyboard events on the video element to the host.
 * Keys go by physical position (KeyboardEvent.code → evdev), so the host's
 * layout decides the character. Elements marked `data-local-keys` keep their keys.
 *
 * In game mode a click captures the mouse (pointer lock) and its motion goes
 * to the host until Esc, Ctrl+Alt+Shift+Z, or the page loses focus.
 */
export class InputForwarder {
  private seq = 0;
  /** Touches go to the Trackpad instead of pointing directly. */
  touchTrackpad = false;
  /** Nothing reaches the host: the Trackpad zooms the picture instead. */
  private viewOnly = false;
  private mode: MouseMode = "desktop";
  private wasLocked = false;
  onLockChange?: (locked: boolean) => void;
  /** Runs, in the capturing gesture, before the mouse is captured (going fullscreen, so every key comes too). */
  beforeCapture?: () => Promise<void>;
  /** A local shortcut was pressed: "mode" asks to switch modes. */
  onCombo?: (combo: MouseCombo) => void;
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

  /** Game mode needs a host that takes relative motion. */
  setMode(mode: MouseMode) {
    this.mode = mode;
    if (mode === "desktop" && this.locked) document.exitPointerLock();
  }

  /** Captures the mouse for a game. Needs a user gesture (a click or key press). */
  capture() {
    if (this.mode !== "game" || this.viewOnly || this.locked) return;
    // Raw mouse counts where the browser has them, as a game reads a mouse.
    // Fullscreen needs no gesture for the lock, so it can come after.
    const lock = (o?: PointerLockOptions) => Promise.resolve(this.video.requestPointerLock(o));
    (this.beforeCapture?.() ?? Promise.resolve())
      .catch(() => {})
      .then(() => lock({ unadjustedMovement: true }))
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
    this.releaseAll();
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
    if (this.mode === "game" && e.pointerType === "mouse") return; // until a click captures it
    const p = this.normalize(e);
    if (p) this.moveTo(p[0], p[1]);
  }

  private onButton(e: PointerEvent, pressed: boolean) {
    if (this.touchTrackpad && e.pointerType === "touch") return;
    if (this.locked) {
      // The host presses where its pointer is (it ignores the position after motion).
      e.preventDefault();
      this.send(this.conn.control, proto.button(e.button, pressed, 0.5, 0.5));
      return;
    }
    if (this.mode === "game" && e.pointerType === "mouse") {
      // The click that captures the mouse is the page's, not the game's.
      e.preventDefault();
      if (pressed && e.button === 0) this.capture();
      return;
    }
    const p = this.normalize(e);
    if (!p) return;
    e.preventDefault();
    if (pressed) this.video.setPointerCapture(e.pointerId);
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
    const combo = e.ctrlKey && e.altKey && e.shiftKey ? COMBOS[e.code] : undefined;
    if (combo) {
      e.preventDefault();
      e.stopPropagation();
      if (!pressed || e.repeat) return;
      // Ctrl, Alt and Shift already went down on the host; let them go.
      this.releaseAll();
      if (combo === "capture") {
        if (this.locked) this.release();
        else this.capture();
      }
      this.onCombo?.(combo);
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
