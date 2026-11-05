// The voice visualizer: your mic (in the theme's primary color) and the
// assistant's voice (its second chart color), drawn from lib/assistant/levels
// every frame while the voice is on. A ring around the mic button, or a row
// of bars for the panel and the voice bar.

import { useEffect, useRef } from "react";
import { bands } from "@/lib/assistant/levels";
import { cn } from "@/lib/utils";

const BANDS = 24;
/** Bars jump up with sound and settle back slowly. */
const ATTACK = 0.55;
const RELEASE = 0.12;
/** Below this the assistant's color doesn't take over: what's left of its last words fading. */
const AUDIBLE = 0.06;

type Rgb = [number, number, number];

/** A theme color as RGB: the canvas parses any CSS color and gives it back as hex. */
function themeColor(g: CanvasRenderingContext2D, name: string, fallback: string): Rgb {
  g.fillStyle = fallback;
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(g.fillStyle));
  return hex ? [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16)] : [120, 130, 75];
}

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${Math.min(1, Math.max(0, a)).toFixed(3)})`;

/** Runs draw every frame while active, with the levels smoothed. */
function useLevels(
  canvas: React.RefObject<HTMLCanvasElement | null>,
  active: boolean,
  draw: (g: CanvasRenderingContext2D, w: number, h: number, mic: Float32Array, out: Float32Array, t: number, colors: [Rgb, Rgb]) => void,
) {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    const el = canvas.current;
    if (!el || !active) return;
    const g = el.getContext("2d");
    if (!g) return;
    const colors: [Rgb, Rgb] = [themeColor(g, "--primary", "#78824b"), themeColor(g, "--chart-2", "#c9a554")];
    const raw = [new Float32Array(BANDS), new Float32Array(BANDS)] as const;
    const smooth = [new Float32Array(BANDS), new Float32Array(BANDS)] as const;
    let frame = 0;
    const tick = (t: number) => {
      const dpr = devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== Math.round(w * dpr)) el.width = Math.round(w * dpr);
      if (el.height !== Math.round(h * dpr)) el.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      bands("mic", raw[0]);
      bands("out", raw[1]);
      for (const [r, sm] of [[raw[0], smooth[0]], [raw[1], smooth[1]]] as const) {
        for (let i = 0; i < BANDS; i++) {
          const v = r[i]!;
          const cur = sm[i]!;
          sm[i] = cur + (v - cur) * (v > cur ? ATTACK : RELEASE);
        }
      }
      drawRef.current(g, w, h, smooth[0], smooth[1], t, colors);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      g.clearRect(0, 0, el.width, el.height);
    };
  }, [canvas, active]);
}

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Bars in a ring around the mic button, mirrored left and right with the
 * low voices at the bottom, and a glow that swells with how loud it is.
 */
export function VoiceRing({ active, className }: { active: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLevels(ref, active, (g, w, h, mic, out, t, [micColor, outColor]) => {
    const cx = w / 2;
    const cy = h / 2;
    const inner = 29;
    const still = calm();
    let level = 0;
    for (let i = 0; i < BANDS; i++) level += Math.max(mic[i]!, out[i]!);
    level /= BANDS;
    const outSum = out.reduce((a, b) => a + b, 0);
    const speaking = outSum > AUDIBLE * BANDS && outSum > mic.reduce((a, b) => a + b, 0);

    // The glow.
    const glow = g.createRadialGradient(cx, cy, inner - 6, cx, cy, inner + 8 + level * 18);
    glow.addColorStop(0, rgba(speaking ? outColor : micColor, 0.18 + level * 0.5));
    glow.addColorStop(1, rgba(speaking ? outColor : micColor, 0));
    g.fillStyle = glow;
    g.beginPath();
    g.arc(cx, cy, inner + 8 + level * 18, 0, Math.PI * 2);
    g.fill();

    // The bars: bar k on each side is band k, from the bottom up.
    const n = BANDS * 2;
    g.lineCap = "round";
    g.lineWidth = 2.5;
    for (let i = 0; i < n; i++) {
      const k = i < BANDS ? i : n - 1 - i;
      const m = mic[k]!;
      const o = out[k]!;
      const amp = Math.max(m, o);
      // Breathing while it's quiet, so it looks alive.
      const idle = still ? 0 : 0.5 + 0.5 * Math.sin(t / 420 + (k / BANDS) * Math.PI * 2);
      const len = 2.5 + idle * 1.5 + amp * 15;
      const a = Math.PI / 2 + ((i + 0.5) / n) * Math.PI * 2;
      g.strokeStyle = rgba(o > m && o > AUDIBLE ? outColor : micColor, 0.4 + amp * 0.6);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      g.lineTo(cx + Math.cos(a) * (inner + len), cy + Math.sin(a) * (inner + len));
      g.stroke();
    }
  });
  return <canvas ref={ref} aria-hidden className={cn("pointer-events-none", className)} />;
}

/** A row of bars: the mic, or the assistant when it's louder. */
export function VoiceBars({ active, className }: { active: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLevels(ref, active, (g, w, h, mic, out, t, [micColor, outColor]) => {
    const n = 16;
    const gap = 2;
    const bw = (w - gap * (n - 1)) / n;
    const still = calm();
    for (let i = 0; i < n; i++) {
      // Mirrored from the middle out, the low voices in the middle.
      const k = Math.min(BANDS - 1, Math.floor((Math.abs(i - (n - 1) / 2) / (n / 2)) * BANDS * 0.8));
      const m = mic[k]!;
      const o = out[k]!;
      const amp = Math.max(m, o);
      const idle = still ? 0 : 0.5 + 0.5 * Math.sin(t / 380 + i * 0.7);
      const bh = Math.max(2, (0.12 + idle * 0.08 + amp * 0.8) * h);
      g.fillStyle = rgba(o > m && o > AUDIBLE ? outColor : micColor, 0.45 + amp * 0.55);
      g.beginPath();
      g.roundRect(i * (bw + gap), (h - bh) / 2, bw, bh, bw / 2);
      g.fill();
    }
  });
  return <canvas ref={ref} aria-hidden className={cn("pointer-events-none", className)} />;
}
