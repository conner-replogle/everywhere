import type { CursorImage, CursorPosition } from "./protocol";

/**
 * Shows the host cursor with zero added latency: the host's cursor bitmap becomes the
 * viewer's native CSS cursor, so it tracks the local mouse. When the host moves the
 * pointer on its own (someone at the host, or an app warping it), an overlay marks it.
 */
export class CursorRenderer {
  private image: CursorImage | null = null;
  private lastLocalMove = 0;
  /** Trackpad mode: the overlay is the pointer, where the viewer steered it. */
  private pinned: { x: number; y: number } | null = null;
  private lastPinMove = 0;
  /** CSS px per host pixel for the overlay (at least readable when pinned). */
  private overlayScale = 1;
  /** Where the host last put the pointer on this picture, 0..1. */
  hostPosition: { x: number; y: number } | null = null;
  /** Pinned: the host moved the pointer itself (someone at the machine). */
  onHostMove?: (pos: { x: number; y: number }) => void;
  private overlay: HTMLCanvasElement;
  private cssCursor = "default";
  private resizeObserver: ResizeObserver;

  constructor(private video: HTMLVideoElement) {
    this.overlay = document.createElement("canvas");
    this.overlay.className = "pointer-events-none fixed z-50 opacity-85";
    this.overlay.hidden = true;
    video.after(this.overlay);
    video.addEventListener("pointermove", this.onLocalMove);
    video.addEventListener("resize", this.render);
    this.resizeObserver = new ResizeObserver(this.render);
    this.resizeObserver.observe(video);
  }

  private onLocalMove = (e: PointerEvent) => {
    if (this.pinned && e.pointerType === "touch") return;
    this.lastLocalMove = performance.now();
    this.overlay.hidden = true;
  };

  dispose() {
    this.video.removeEventListener("pointermove", this.onLocalMove);
    this.video.removeEventListener("resize", this.render);
    this.resizeObserver.disconnect();
    this.overlay.remove();
    this.video.style.cursor = "";
  }

  /** Shows the overlay as the pointer at pos (0..1), or goes back to the native cursor. */
  pin(pos: { x: number; y: number } | null) {
    const was = this.pinned;
    this.pinned = pos;
    this.lastPinMove = performance.now();
    if (!pos) {
      this.overlay.hidden = true;
      this.setPressed(false);
      if (was) this.render();
      return;
    }
    if (!was) this.render();
    this.place(pos);
  }

  /** Marks a held button (a trackpad drag). */
  setPressed(on: boolean) {
    this.overlay.style.filter = on ? "drop-shadow(0 0 3px var(--color-primary)) drop-shadow(0 0 1px var(--color-primary))" : "";
  }

  /** Redraws after the picture moved or scaled without resizing (zoom). */
  refresh() {
    this.render();
  }

  setImage(img: CursorImage) {
    this.image = img.width && img.height ? img : null;
    this.render();
  }

  setPosition(pos: CursorPosition) {
    if (pos.inside) this.hostPosition = { x: pos.x, y: pos.y };
    if (this.pinned) {
      if (pos.inside && performance.now() - this.lastPinMove > 300) {
        this.pinned = { x: pos.x, y: pos.y };
        this.place(this.pinned);
        this.onHostMove?.(this.pinned);
      }
      return;
    }
    // Local motion drives the visible cursor; only show host-originated movement.
    if (!pos.inside || performance.now() - this.lastLocalMove < 300) {
      this.overlay.hidden = true;
      return;
    }
    this.place(pos);
  }

  private place(pos: { x: number; y: number }) {
    const r = this.contentRect();
    if (!r) return;
    const img = this.image;
    const scale = this.overlayScale;
    this.overlay.style.left = `${r.left + pos.x * r.width - (img ? img.hotX * scale : 0)}px`;
    this.overlay.style.top = `${r.top + pos.y * r.height - (img ? img.hotY * scale : 0)}px`;
    this.overlay.hidden = false;
  }

  /** The video's picture on screen, inside any letterboxing. */
  contentRect() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return null;
    const box = this.video.getBoundingClientRect();
    const scale = Math.min(box.width / vw, box.height / vh);
    const width = vw * scale, height = vh * scale;
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
  }

  private render = () => {
    const img = this.image;
    const r = this.contentRect();
    if (!img || !r) {
      this.setCss("default");
      this.overlayScale = 1;
      this.drawOverlay(null);
      if (this.pinned) this.place(this.pinned);
      return;
    }
    // Host cursor pixels are video pixels; show them at the size they appear in the video.
    const cssScale = r.width / this.video.videoWidth;
    const src = new OffscreenCanvas(img.width, img.height);
    src.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
    const canvas = scaledCursor(src, cssScale);
    const url = canvas.toDataURL("image/png");
    const dpr = window.devicePixelRatio || 1;
    const hx = Math.round(img.hotX * cssScale), hy = Math.round(img.hotY * cssScale);
    this.setCss(`image-set(url("${url}") ${dpr}x) ${hx} ${hy}, url("${url}") ${hx} ${hy}, default`);
    // A whole desktop on a phone shrinks the pointer to a speck; one steered
    // by trackpad stays big enough to aim.
    this.overlayScale = this.pinned ? Math.max(cssScale, MIN_PINNED_HEIGHT / img.height) : cssScale;
    this.drawOverlay(this.overlayScale === cssScale ? canvas : scaledCursor(src, this.overlayScale));
    if (this.pinned) this.place(this.pinned);
  };

  private setCss(value: string) {
    if (value === this.cssCursor) return;
    this.cssCursor = value;
    this.video.style.cursor = value;
  }

  private drawOverlay(source: HTMLCanvasElement | null) {
    const o = this.overlay;
    const dpr = window.devicePixelRatio || 1;
    if (source) {
      o.width = source.width;
      o.height = source.height;
      o.getContext("2d")!.drawImage(source, 0, 0);
    } else {
      // No host bitmap (Hyprland can't capture cursor-shape cursors): draw a plain arrow.
      o.width = o.height = Math.round(20 * dpr);
      const ctx = o.getContext("2d")!;
      ctx.scale(dpr, dpr);
      ctx.beginPath();
      ctx.moveTo(1, 1);
      ctx.lineTo(1, 16);
      ctx.lineTo(5, 12);
      ctx.lineTo(8, 18);
      ctx.lineTo(10.5, 17);
      ctx.lineTo(7.5, 11);
      ctx.lineTo(13, 11);
      ctx.closePath();
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1.2;
      ctx.fill();
      ctx.stroke();
    }
    o.style.width = `${o.width / dpr}px`;
    o.style.height = `${o.height / dpr}px`;
  }
}

/** The pinned pointer is drawn at least this tall (CSS px). */
const MIN_PINNED_HEIGHT = 22;

/** The host's cursor bitmap drawn at `scale` CSS px per pixel, sharp on this screen. */
function scaledCursor(src: OffscreenCanvas, scale: number): HTMLCanvasElement {
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(Math.max(1, Math.round(src.width * scale)) * dpr));
  canvas.height = Math.max(1, Math.round(Math.max(1, Math.round(src.height * scale)) * dpr));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}
