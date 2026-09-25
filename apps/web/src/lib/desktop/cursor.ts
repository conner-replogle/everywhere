import type { CursorImage, CursorPosition } from "./protocol";

/**
 * Shows the host cursor with zero added latency: the host's cursor bitmap becomes the
 * viewer's native CSS cursor, so it tracks the local mouse. When the host moves the
 * pointer on its own (someone at the host, or an app warping it), an overlay marks it.
 */
export class CursorRenderer {
  private image: CursorImage | null = null;
  private lastLocalMove = 0;
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

  private onLocalMove = () => {
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

  setImage(img: CursorImage) {
    this.image = img.width && img.height ? img : null;
    this.render();
  }

  setPosition(pos: CursorPosition) {
    // Local motion drives the visible cursor; only show host-originated movement.
    if (!pos.inside || performance.now() - this.lastLocalMove < 300) {
      this.overlay.hidden = true;
      return;
    }
    const r = this.contentRect();
    if (!r) return;
    const img = this.image;
    const scale = r.width / this.video.videoWidth;
    this.overlay.style.left = `${r.left + pos.x * r.width - (img ? img.hotX * scale : 0)}px`;
    this.overlay.style.top = `${r.top + pos.y * r.height - (img ? img.hotY * scale : 0)}px`;
    this.overlay.hidden = false;
  }

  private contentRect() {
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
      this.drawOverlay(null);
      return;
    }
    // Host cursor pixels are video pixels; show them at the size they appear in the video.
    const cssScale = r.width / this.video.videoWidth;
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, Math.round(img.width * cssScale));
    const cssH = Math.max(1, Math.round(img.height * cssScale));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    const src = new OffscreenCanvas(img.width, img.height);
    src.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/png");
    const hx = Math.round(img.hotX * cssScale), hy = Math.round(img.hotY * cssScale);
    this.setCss(`image-set(url("${url}") ${dpr}x) ${hx} ${hy}, url("${url}") ${hx} ${hy}, default`);
    this.drawOverlay(canvas);
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
