import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal } from "@xterm/xterm";
import { EyeIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyModifiers, type Modifiers, TerminalKeys, useCoarsePointer } from "@/components/terminal-keys";
import { Button } from "@/components/ui/button";
import type { DevicePeer, TerminalChannel } from "@/lib/peer";
import { errorMessage } from "@/lib/utils";

const FONT_FAMILY = '"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace';

const THEME: ITheme = {
  background: "#0e1014",
  foreground: "#d7dbe3",
  cursor: "#8fa8ff",
  cursorAccent: "#0e1014",
  selectionBackground: "#8fa8ff4d",
  black: "#1d2129",
  red: "#f07178",
  green: "#8fd694",
  yellow: "#e8c46a",
  blue: "#82aaff",
  magenta: "#c79bf2",
  cyan: "#6fd3d8",
  white: "#c8ccd6",
  brightBlack: "#5c6370",
  brightRed: "#ff8a91",
  brightGreen: "#a6e6aa",
  brightYellow: "#f5d58a",
  brightBlue: "#a3c0ff",
  brightMagenta: "#dbb5ff",
  brightCyan: "#8fe6ea",
  brightWhite: "#f2f4f8",
};

const NO_MODS: Modifiers = { ctrl: false, alt: false };

export type WriterState = "pending" | "writer" | "viewer" | "exited";

export function TerminalView({
  peer,
  threadId,
  generation,
  onWriterChange,
  active = true,
}: {
  peer: DevicePeer;
  threadId: string;
  /** Peer connection generation; a new one means reopen the channel. */
  generation: number;
  onWriterChange?: (w: WriterState) => void;
  /** False while the terminal sits in a background tab; it takes focus when shown. */
  active?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const chanRef = useRef<TerminalChannel | null>(null);
  const writerRef = useRef(false);
  const exitedRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [writer, setWriter] = useState<WriterState>("pending");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachKey, setAttachKey] = useState(0);

  const reattach = useCallback(() => setAttachKey((k) => k + 1), []);

  // Sticky Ctrl/Alt from the key row; they apply to the next key, from the row or the keyboard.
  const touch = useCoarsePointer();
  const [mods, setMods] = useState<Modifiers>(NO_MODS);
  const modsRef = useRef<Modifiers>(NO_MODS);
  const setModifiers = useCallback((m: Modifiers) => {
    modsRef.current = m;
    setMods(m);
  }, []);
  const sendKeys = useCallback(
    (data: string) => {
      setModifiers(NO_MODS);
      if (exitedRef.current) reattach();
      else if (writerRef.current) chanRef.current?.sendInput(data);
    },
    [reattach, setModifiers],
  );

  const onWriterChangeRef = useRef(onWriterChange);
  onWriterChangeRef.current = onWriterChange;
  useEffect(() => {
    onWriterChangeRef.current?.(exitCode !== null ? "exited" : writer);
  }, [writer, exitCode]);

  useEffect(() => {
    if (active && ready) termRef.current?.focus();
  }, [active, ready]);

  // xterm instance: one per mount.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      // Glyph metrics are measured at open(); make sure the web font is there.
      try {
        await document.fonts.load(`13px ${FONT_FAMILY}`);
      } catch {
        // fall through with whatever font is available
      }
      if (disposed) return;

      const term = new Terminal({
        fontFamily: FONT_FAMILY,
        fontSize: 13,
        lineHeight: 1.15,
        cursorBlink: true,
        scrollback: 10_000,
        theme: THEME,
        allowTransparency: false,
        macOptionIsMeta: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch (e) {
        console.info("WebGL renderer unavailable, using DOM renderer", e);
      }
      fit.fit();

      const onData = term.onData((data) => {
        const m = modsRef.current;
        sendKeys(m.ctrl || m.alt ? applyModifiers(data, m) : data);
      });
      const onResize = term.onResize(({ cols, rows }) => {
        if (writerRef.current) chanRef.current?.sendControl({ t: "resize", cols, rows });
      });

      let raf = 0;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          try {
            fit.fit();
          } catch {
            // element detached mid-resize
          }
        });
      });
      ro.observe(el);
      const stopTouchScroll = touchScroll(term, el);

      termRef.current = term;
      setReady(true);
      term.focus();

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        stopTouchScroll();
        onData.dispose();
        onResize.dispose();
        term.dispose();
        termRef.current = null;
      };
    })();

    return () => {
      disposed = true;
      setReady(false);
      cleanup();
    };
  }, [sendKeys]);

  // Terminal channel: one per (thread, connection, attach).
  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term) return;

    term.reset();
    writerRef.current = false;
    exitedRef.current = false;
    setWriter("pending");
    setExitCode(null);
    setClosed(false);
    setError(null);

    let ch: TerminalChannel;
    try {
      ch = peer.openTerminal(threadId, {
        onOpen: () => ch.sendControl({ t: "attach", cols: term.cols, rows: term.rows }),
        onOutput: (bytes) => term.write(bytes),
        onControl: (msg) => {
          switch (msg.t) {
            case "writer": {
              const wasWriter = writerRef.current;
              writerRef.current = msg.you;
              setWriter(msg.you ? "writer" : "viewer");
              // Promoted (e.g. the other writer left): make the PTY match our size.
              if (msg.you && !wasWriter) ch.sendControl({ t: "resize", cols: term.cols, rows: term.rows });
              if (msg.you) term.focus();
              return;
            }
            case "exited":
              exitedRef.current = true;
              setExitCode(msg.code);
              return;
            case "error":
              setError(msg.message);
              return;
          }
        },
        onClose: () => setClosed(true),
      });
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    chanRef.current = ch;
    return () => {
      ch.close();
      if (chanRef.current === ch) chanRef.current = null;
    };
  }, [ready, peer, threadId, generation, attachKey]);

  const takeover = () => {
    const term = termRef.current;
    if (!term) return;
    chanRef.current?.sendControl({ t: "takeover", cols: term.cols, rows: term.rows });
    term.focus();
  };

  const exited = exitCode !== null;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-terminal">
      {writer === "viewer" && !exited && !closed && (
        <Banner tone="info">
          <EyeIcon className="size-3.5 shrink-0" />
          <span className="flex-1">Read-only — this terminal is being used on another client.</span>
          <Button size="sm" variant="secondary" onClick={takeover}>
            Take over
          </Button>
        </Banner>
      )}
      {error && (
        <Banner tone="error">
          <span className="flex-1">{error}</span>
          <Button size="sm" variant="secondary" onClick={reattach}>
            <RotateCcwIcon />
            Reconnect
          </Button>
        </Banner>
      )}
      {closed && !exited && !error && (
        <Banner tone="error">
          <span className="flex-1">Terminal disconnected.</span>
          <Button size="sm" variant="secondary" onClick={reattach}>
            <RotateCcwIcon />
            Reconnect
          </Button>
        </Banner>
      )}
      <div className="relative min-h-0 flex-1" onMouseDown={() => termRef.current?.focus()}>
        <div ref={containerRef} className="absolute inset-0 overflow-hidden" />
        {exited && (
          <button
            type="button"
            onClick={reattach}
            className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 border-t bg-sidebar/95 px-3 py-2.5 text-[13px] text-muted-foreground backdrop-blur-sm hover:text-foreground focus-visible:outline-none"
          >
            <span className="text-foreground">Shell exited{exitCode !== 0 ? ` with code ${exitCode}` : ""}</span>
            <span>— press any key or click to start a new shell</span>
          </button>
        )}
      </div>
      {touch && writer === "writer" && !exited && !closed && (
        <TerminalKeys
          mods={mods}
          onToggle={(mod) => setModifiers({ ...modsRef.current, [mod]: !modsRef.current[mod] })}
          onKeys={sendKeys}
          applicationCursor={() => !!termRef.current?.modes.applicationCursorKeysMode}
        />
      )}
    </div>
  );
}

/**
 * xterm doesn't scroll on touch. One-finger drags move through scrollback, or,
 * when an app owns the screen (mouse tracking, alternate buffer), become wheel
 * events that xterm forwards to it. A flick keeps going and slows down like
 * native scrolling. Taps still reach xterm and bring up the keyboard.
 */
function touchScroll(term: Terminal, el: HTMLElement): () => void {
  // iOS's normal deceleration: velocity keeps this fraction per millisecond.
  const FRICTION = 0.998;
  const MIN_FLING = 0.1; // px/ms; slower releases just stop
  const SAMPLE_MS = 100; // velocity is measured over the last part of the drag

  let lastY = 0;
  let lastX = 0;
  let dragging = false;
  let pending = 0; // pixels not yet worth a whole row
  let samples: { t: number; y: number }[] = [];
  let raf = 0;
  let flingV = 0; // current fling velocity, px/ms
  let carry = 0; // what was left of a fling when a new touch caught it

  const scrollBy = (dy: number) => {
    if (term.buffer.active.type === "normal" && term.modes.mouseTrackingMode === "none") {
      const rowHeight = el.clientHeight / term.rows;
      pending += dy;
      const lines = Math.trunc(pending / rowHeight);
      if (lines !== 0) {
        pending -= lines * rowHeight;
        term.scrollLines(lines);
      }
    } else {
      term.element?.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: dy,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          clientX: lastX,
          clientY: lastY,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  };

  const fling = (velocity: number) => {
    flingV = velocity;
    let prev = performance.now();
    const step = (now: number) => {
      const dt = Math.min(now - prev, 50);
      prev = now;
      scrollBy(flingV * dt);
      flingV *= FRICTION ** dt;
      if (Math.abs(flingV) > 0.02) raf = requestAnimationFrame(step);
      else raf = flingV = 0;
    };
    raf = requestAnimationFrame(step);
  };

  const onStart = (e: TouchEvent) => {
    // A touch catches a fling, as on native lists.
    cancelAnimationFrame(raf);
    carry = flingV;
    raf = flingV = 0;
    if (e.touches.length !== 1) return;
    const t = e.touches[0]!;
    lastY = t.clientY;
    lastX = t.clientX;
    dragging = false;
    pending = 0;
    samples = [{ t: e.timeStamp, y: t.clientY }];
  };
  const onMove = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0]!;
    const dy = lastY - t.clientY;
    if (!dragging && Math.abs(dy) < 6) return;
    dragging = true;
    lastY = t.clientY;
    lastX = t.clientX;
    e.preventDefault();
    samples.push({ t: e.timeStamp, y: t.clientY });
    while (samples.length > 2 && e.timeStamp - samples[0]!.t > SAMPLE_MS) samples.shift();
    scrollBy(dy);
  };
  const onEnd = (e: TouchEvent) => {
    if (!dragging || e.touches.length > 0) return;
    dragging = false;
    const first = samples[0];
    const last = samples[samples.length - 1];
    // A finger that paused before lifting shouldn't fling.
    if (!first || !last || e.timeStamp - last.t > SAMPLE_MS || last.t === first.t) return;
    let v = (first.y - last.y) / (last.t - first.t);
    if (Math.abs(v) < MIN_FLING) return;
    // Flicking again in the same direction builds on the fling still in motion.
    if (Math.sign(v) === Math.sign(carry)) v += carry;
    fling(v);
  };

  el.addEventListener("touchstart", onStart, { passive: true });
  el.addEventListener("touchmove", onMove, { passive: false });
  el.addEventListener("touchend", onEnd, { passive: true });
  el.addEventListener("touchcancel", onEnd, { passive: true });
  return () => {
    cancelAnimationFrame(raf);
    el.removeEventListener("touchstart", onStart);
    el.removeEventListener("touchmove", onMove);
    el.removeEventListener("touchend", onEnd);
    el.removeEventListener("touchcancel", onEnd);
  };
}

function Banner({ tone, children }: { tone: "info" | "error"; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={
        "flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[13px] " +
        (tone === "info" ? "bg-warn/10 text-warn" : "bg-destructive/10 text-destructive")
      }
    >
      {children}
    </div>
  );
}
