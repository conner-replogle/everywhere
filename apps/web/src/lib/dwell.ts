// Time spent looking at something, counted only while the page is in the
// foreground (visible and focused): a background tab or another app on top
// doesn't count, and counting resumes where it stopped.

import { useEffect, useRef } from "react";

/** Adds up foreground time. Times are from a monotonic clock (performance.now). */
export class Dwell {
  private total = 0;
  private since: number | null = null;

  constructor(readonly target: number) {}

  setForeground(foreground: boolean, now: number): void {
    if (foreground && this.since === null) this.since = now;
    else if (!foreground && this.since !== null) {
      this.total += now - this.since;
      this.since = null;
    }
  }

  get foreground(): boolean {
    return this.since !== null;
  }

  elapsed(now: number): number {
    return this.total + (this.since === null ? 0 : now - this.since);
  }

  remaining(now: number): number {
    return Math.max(0, this.target - this.elapsed(now));
  }

  done(now: number): boolean {
    return this.elapsed(now) >= this.target;
  }
}

const inForeground = () => document.visibilityState === "visible" && document.hasFocus();

/**
 * Calls onDone once after ms of foreground time while enabled. Turning it off
 * or changing key starts the count over.
 */
export function useForegroundDwell(enabled: boolean, ms: number, key: string, onDone: () => void): void {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (!enabled) return;
    const dwell = new Dwell(ms);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fired = false;
    const update = () => {
      clearTimeout(timer);
      if (fired) return;
      const now = performance.now();
      dwell.setForeground(inForeground(), now);
      if (dwell.done(now)) {
        fired = true;
        onDoneRef.current();
      } else if (dwell.foreground) {
        timer = setTimeout(update, dwell.remaining(now));
      }
    };
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, [enabled, ms, key]);
}
