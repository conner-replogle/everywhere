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
 * Forwards pointer and keyboard events on the video element to the host.
 * Keys go by physical position (KeyboardEvent.code → evdev), so the host's
 * layout decides the character. Elements marked `data-local-keys` keep their keys.
 */
export class InputForwarder {
  private seq = 0;
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
  }

  dispose() {
    this.releaseAll();
    this.detach.forEach((f) => f());
    this.detach = [];
  }

  private listen<K extends keyof HTMLElementEventMap | "visibilitychange">(
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

  private onMove(e: PointerEvent) {
    const p = this.normalize(e);
    if (p) this.send(this.conn.input, proto.move(this.seq++, p[0], p[1]));
  }

  private onButton(e: PointerEvent, pressed: boolean) {
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
    const code = e.code === this.opts.superSubstitute ? KEY_LEFTMETA : EVDEV[e.code];
    if (code === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return; // the host application generates its own repeats
    if (pressed) this.pressedKeys.add(code);
    else this.pressedKeys.delete(code);
    this.send(this.conn.control, proto.key(code, pressed));
  }

  releaseAll() {
    this.pressedKeys.clear();
    this.send(this.conn.control, proto.releaseAll());
  }
}

function isWheelNotch(d: number): boolean {
  return d === 0 || (Number.isInteger(d) && d % 120 === 0);
}
