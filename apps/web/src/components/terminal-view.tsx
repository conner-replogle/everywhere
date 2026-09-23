import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal } from "@xterm/xterm";
import { EyeIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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

export type WriterState = "pending" | "writer" | "viewer" | "exited";

export function TerminalView({
  peer,
  threadId,
  generation,
  onWriterChange,
}: {
  peer: DevicePeer;
  threadId: string;
  /** Peer connection generation; a new one means reopen the channel. */
  generation: number;
  onWriterChange?: (w: WriterState) => void;
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

  useEffect(() => {
    onWriterChange?.(exitCode !== null ? "exited" : writer);
  }, [writer, exitCode, onWriterChange]);

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
        if (exitedRef.current) {
          reattach();
          return;
        }
        if (writerRef.current) chanRef.current?.sendInput(data);
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

      termRef.current = term;
      setReady(true);
      term.focus();

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
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
  }, [reattach]);

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
    </div>
  );
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
