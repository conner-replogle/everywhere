import type { BrowserClientMsg, BrowserState, BrowserViewport } from "@everywhere/protocol";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  KeyboardIcon,
  LoaderIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import { type FormEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { BrowserChannel, BrowserFrameHeader } from "@/lib/browser-channel";
import {
  isShortcut,
  keyMessage,
  modifiers,
  normalizeUrl,
  safeCursor,
  syntheticKey,
  wheelPixels,
} from "@/lib/browser-input";
import type { DevicePeer } from "@/lib/peer";
import { cn, errorMessage } from "@/lib/utils";

interface Settings {
  quality: number;
  /** Render at the screen's pixel ratio (up to 2x) instead of 1x. */
  sharp: boolean;
}

const SETTINGS_KEY = "ew.browser.settings";
const QUALITIES = [
  { label: "Low", value: 40 },
  { label: "Medium", value: 65 },
  { label: "High", value: 85 },
];
const DEFAULT_SETTINGS: Settings = { quality: 65, sharp: true };

function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const BLANK: BrowserState = { url: "about:blank", title: "", loading: false, canGoBack: false, canGoForward: false };
const DOUBLE_CLICK_MS = 500;
const TAP_SLOP_PX = 8;
const coarsePointer = window.matchMedia("(pointer: coarse)").matches;

interface Stats {
  fps: number;
  bytesPerSec: number;
  avgFrame: number;
}

/**
 * A Chromium tab running on the device, streamed as JPEG frames onto a
 * canvas. Pointer, wheel and keyboard input go back over the channel; the
 * page's cursor comes back as a message and is applied to the canvas.
 */
export function BrowserView({
  peer,
  projectId,
  generation,
  remoteOs,
  onClose,
}: {
  peer: DevicePeer;
  projectId: string;
  /** Peer connection generation; a new one means reopen the channel. */
  generation: number;
  remoteOs?: string;
  onClose?: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sinkRef = useRef<HTMLTextAreaElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const chanRef = useRef<BrowserChannel | null>(null);
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  const frameSizeRef = useRef({ width: 0, height: 0 });

  const [settings, setSettings] = useState(loadSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [status, setStatus] = useState<"connecting" | "live" | "closed">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<BrowserState>(BLANK);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [cursor, setCursor] = useState("default");
  const [notice, setNotice] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [attachKey, setAttachKey] = useState(0);
  const remoteMac = remoteOs === "darwin";

  const send = useCallback((msg: BrowserClientMsg) => chanRef.current?.send(msg), []);

  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showNotice = useCallback((text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const viewport = useCallback((): BrowserViewport | null => {
    const s = sizeRef.current;
    if (!s || s.width < 1 || s.height < 1) return null;
    const { quality, sharp } = settingsRef.current;
    return { ...s, dpr: sharp ? Math.min(window.devicePixelRatio || 1, 2) : 1, quality };
  }, []);

  // --- frames -----------------------------------------------------------------

  const counters = useRef({ frames: 0, bytes: 0 });
  const pendingFrame = useRef<{ hdr: BrowserFrameHeader; jpeg: Uint8Array<ArrayBuffer> } | null>(null);
  const decoding = useRef(false);

  // Decodes off the main thread and always draws the newest frame, skipping
  // any that arrived while the previous one was decoding.
  const draw = useCallback((hdr: BrowserFrameHeader, jpeg: Uint8Array<ArrayBuffer>) => {
    pendingFrame.current = { hdr, jpeg };
    if (decoding.current) return;
    decoding.current = true;
    void (async () => {
      while (pendingFrame.current) {
        const f = pendingFrame.current;
        pendingFrame.current = null;
        try {
          const bmp = await createImageBitmap(new Blob([f.jpeg], { type: "image/jpeg" }));
          const c = canvasRef.current;
          if (c) {
            if (c.width !== bmp.width || c.height !== bmp.height) {
              c.width = bmp.width;
              c.height = bmp.height;
            }
            c.getContext("2d")?.drawImage(bmp, 0, 0);
          }
          bmp.close();
          const fs = frameSizeRef.current;
          if (fs.width !== f.hdr.width || fs.height !== f.hdr.height) {
            frameSizeRef.current = { width: f.hdr.width, height: f.hdr.height };
            setFrameSize(frameSizeRef.current);
          }
        } catch {
          // a corrupt frame; the next one replaces it
        }
      }
      decoding.current = false;
    })();
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const { frames, bytes } = counters.current;
      counters.current = { frames: 0, bytes: 0 };
      setStats({ fps: frames, bytesPerSec: bytes, avgFrame: frames ? bytes / frames : 0 });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // --- channel ----------------------------------------------------------------

  useEffect(() => {
    setStatus("connecting");
    setError(null);
    let chan: BrowserChannel;
    try {
      chan = peer.openBrowser(projectId, {
        onOpen: () => {
          chan.send({ t: "attach", ...(viewport() ?? { width: 800, height: 600, dpr: 1, quality: 65 }) });
        },
        onFrame: (hdr, jpeg) => {
          counters.current.frames++;
          counters.current.bytes += hdr.size;
          setStatus("live");
          draw(hdr, jpeg);
        },
        onMessage: (msg) => {
          switch (msg.t) {
            case "state": {
              const { t: _, ...state } = msg;
              setPage(state);
              break;
            }
            case "cursor":
              setCursor(safeCursor(msg.cursor));
              break;
            case "clipboard":
              navigator.clipboard.writeText(msg.text).catch(() => showNotice("Couldn't write to your clipboard"));
              break;
            case "notice":
              showNotice(msg.message);
              break;
            case "error":
              setError(msg.message);
              break;
          }
        },
        onClose: () => setStatus("closed"),
      });
    } catch (e) {
      setError(errorMessage(e));
      setStatus("closed");
      return;
    }
    chanRef.current = chan;
    return () => {
      chanRef.current = null;
      chan.close();
    };
  }, [peer, projectId, generation, attachKey, viewport, draw, showNotice]);

  // The tab follows this view's size.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      sizeRef.current = { width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) };
      clearTimeout(timer);
      timer = setTimeout(() => {
        const vp = viewport();
        if (vp) send({ t: "resize", ...vp });
      }, 120);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  }, [viewport, send]);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // storage unavailable
    }
    const vp = viewport();
    if (vp) send({ t: "resize", ...vp });
  }, [settings, viewport, send]);

  // --- pointer ------------------------------------------------------------------

  /** Client coordinates to the page's CSS pixels. */
  const toPage = useCallback((clientX: number, clientY: number) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    const fs = frameSizeRef.current;
    const sx = r.width && fs.width ? fs.width / r.width : 1;
    const sy = r.height && fs.height ? fs.height / r.height : 1;
    return { x: (clientX - r.left) * sx, y: (clientY - r.top) * sy };
  }, []);

  const move = useRef<{ x: number; y: number; buttons: number; modifiers: number } | null>(null);
  const moveRaf = useRef(0);
  const flushMove = useCallback(() => {
    cancelAnimationFrame(moveRaf.current);
    moveRaf.current = 0;
    const m = move.current;
    move.current = null;
    if (m) send({ t: "mouse", kind: "move", ...m });
  }, [send]);

  const clicks = useRef({ at: 0, x: 0, y: 0, button: -1, count: 0 });
  const touch = useRef<{ id: number; startX: number; startY: number; lastX: number; lastY: number; dragging: boolean } | null>(
    null,
  );

  const wheel = useRef<{ dx: number; dy: number; x: number; y: number; modifiers: number } | null>(null);
  const wheelRaf = useRef(0);
  const queueWheel = useCallback(
    (dx: number, dy: number, x: number, y: number, mods: number) => {
      const w = wheel.current;
      wheel.current = w ? { ...w, dx: w.dx + dx, dy: w.dy + dy, x, y } : { dx, dy, x, y, modifiers: mods };
      if (wheelRaf.current) return;
      wheelRaf.current = requestAnimationFrame(() => {
        wheelRaf.current = 0;
        const q = wheel.current;
        wheel.current = null;
        if (q) send({ t: "mouse", kind: "wheel", x: q.x, y: q.y, deltaX: q.dx, deltaY: q.dy, modifiers: q.modifiers });
      });
    },
    [send],
  );

  const click = useCallback(
    (x: number, y: number, button: number, count: number, mods: number) => {
      const buttons = [1, 4, 2, 8, 16][button] ?? 0;
      send({ t: "mouse", kind: "move", x, y, modifiers: mods });
      send({ t: "mouse", kind: "down", x, y, button, buttons, clickCount: count, modifiers: mods });
      send({ t: "mouse", kind: "up", x, y, button, buttons: 0, clickCount: count, modifiers: mods });
    },
    [send],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = toPage(e.clientX, e.clientY);
    if (e.pointerType === "touch") {
      if (!touch.current) touch.current = { id: e.pointerId, startX: x, startY: y, lastX: x, lastY: y, dragging: false };
      return;
    }
    sinkRef.current?.focus({ preventScroll: true });
    const c = clicks.current;
    const again = e.timeStamp - c.at < DOUBLE_CLICK_MS && Math.hypot(x - c.x, y - c.y) < 5 && c.button === e.button;
    clicks.current = { at: e.timeStamp, x, y, button: e.button, count: again ? c.count + 1 : 1 };
    flushMove();
    const mods = modifiers(e, remoteMac);
    send({ t: "mouse", kind: "down", x, y, button: e.button, buttons: e.buttons, clickCount: clicks.current.count, modifiers: mods });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = toPage(e.clientX, e.clientY);
    const t = touch.current;
    if (e.pointerType === "touch") {
      if (!t || t.id !== e.pointerId) return;
      if (!t.dragging && Math.hypot(x - t.startX, y - t.startY) > TAP_SLOP_PX) t.dragging = true;
      if (t.dragging) {
        // A drag scrolls, like it would on the phone itself.
        queueWheel(t.lastX - x, t.lastY - y, t.startX, t.startY, 0);
        t.lastX = x;
        t.lastY = y;
      }
      return;
    }
    move.current = { x, y, buttons: e.buttons, modifiers: modifiers(e, remoteMac) };
    if (!moveRaf.current) moveRaf.current = requestAnimationFrame(flushMove);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = toPage(e.clientX, e.clientY);
    if (e.pointerType === "touch") {
      const t = touch.current;
      if (!t || t.id !== e.pointerId) return;
      touch.current = null;
      if (!t.dragging) click(t.startX, t.startY, 0, 1, 0);
      return;
    }
    flushMove();
    send({
      t: "mouse",
      kind: "up",
      x,
      y,
      button: e.button,
      buttons: e.buttons,
      clickCount: clicks.current.count,
      modifiers: modifiers(e, remoteMac),
    });
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (touch.current?.id === e.pointerId) touch.current = null;
  };

  // React's wheel listener is passive; this one has to be able to stop the
  // panel itself from scrolling.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = toPage(e.clientX, e.clientY);
      const { dx, dy } = wheelPixels(e, frameSizeRef.current.height || 600);
      queueWheel(dx, dy, x, y, modifiers(e, remoteMac));
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [toPage, queueWheel, remoteMac]);

  useEffect(
    () => () => {
      cancelAnimationFrame(moveRaf.current);
      cancelAnimationFrame(wheelRaf.current);
    },
    [],
  );

  // --- keyboard -----------------------------------------------------------------
  // Keys go to a hidden textarea. Plain key presses are forwarded as key
  // events; text that arrives any other way (IME composition, dictation,
  // phone keyboards, paste) is inserted as text.

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ne = e.nativeEvent;
    if (ne.isComposing || ne.keyCode === 229) return;
    const mods = modifiers(ne, remoteMac);
    const k = ne.key.toLowerCase();
    if (isShortcut(mods)) {
      if (k === "v") return; // the paste event below brings the text
      if (k === "l") {
        e.preventDefault();
        urlRef.current?.focus();
        return;
      }
      if (k === "r") {
        e.preventDefault();
        send({ t: "reload" });
        return;
      }
      // Copy the remote selection to this clipboard, before a cut removes it.
      if (k === "c" || k === "x") send({ t: "copy" });
    }
    e.preventDefault();
    send(keyMessage(ne, "down", mods));
  };

  const onKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ne = e.nativeEvent;
    if (ne.isComposing || ne.keyCode === 229) return;
    e.preventDefault();
    send(keyMessage(ne, "up", modifiers(ne, remoteMac)));
  };

  const takeSinkText = () => {
    const sink = sinkRef.current;
    if (!sink) return "";
    const v = sink.value;
    sink.value = "";
    return v;
  };

  const onInput = (e: FormEvent<HTMLTextAreaElement>) => {
    const ne = e.nativeEvent as InputEvent;
    if (ne.isComposing) return;
    if (ne.inputType === "deleteContentBackward") {
      takeSinkText();
      for (const m of syntheticKey("Backspace")) send(m);
      return;
    }
    if (ne.inputType === "insertLineBreak" || ne.inputType === "insertParagraph") {
      takeSinkText();
      for (const m of syntheticKey("Enter")) send(m);
      return;
    }
    const text = takeSinkText();
    if (text) send({ t: "text", text });
  };

  const onCompositionEnd = () => {
    const text = takeSinkText();
    if (text) send({ t: "text", text });
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (text) send({ t: "text", text });
  };

  // --- toolbar ------------------------------------------------------------------

  const navigate = (e: FormEvent) => {
    e.preventDefault();
    if (draftUrl === null) return;
    send({ t: "navigate", url: normalizeUrl(draftUrl) });
    setDraftUrl(null);
    urlRef.current?.blur();
    sinkRef.current?.focus({ preventScroll: true });
  };

  const blank = page.url === "about:blank";
  const connected = status !== "closed" && !error;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="@container flex h-9 shrink-0 items-center gap-0.5 border-b bg-sidebar px-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          disabled={!page.canGoBack}
          onClick={() => send({ t: "back" })}
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          disabled={!page.canGoForward}
          onClick={() => send({ t: "forward" })}
        >
          <ArrowRightIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={page.loading ? "Stop" : "Reload"}
          onClick={() => send({ t: page.loading ? "stop" : "reload" })}
        >
          {page.loading ? <XIcon /> : <RotateCwIcon />}
        </Button>
        <form className="mx-1 min-w-24 flex-1" onSubmit={navigate}>
          <input
            ref={urlRef}
            value={draftUrl ?? (blank ? "" : page.url)}
            onChange={(e) => setDraftUrl(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setDraftUrl(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraftUrl(null);
                e.currentTarget.blur();
              }
            }}
            placeholder="URL, or a port like 5173"
            aria-label="Address"
            title={page.title || undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-6 w-full rounded-sm border border-transparent bg-background px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </form>
        {stats && status === "live" && (
          <span
            className="hidden shrink-0 px-1 font-mono text-[11px] text-muted-foreground tabular-nums @xl:inline"
            title={
              frameSize
                ? `${frameSize.width}×${frameSize.height} CSS px at ${viewport()?.dpr ?? 1}x, JPEG quality ${settings.quality}`
                : undefined
            }
          >
            {stats.fps} fps · {formatBytes(stats.bytesPerSec)}/s · {formatBytes(stats.avgFrame)}/frame
          </span>
        )}
        {coarsePointer && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Keyboard"
            onClick={() => {
              const sink = sinkRef.current;
              if (!sink) return;
              if (document.activeElement === sink) sink.blur();
              else sink.focus({ preventScroll: true });
            }}
          >
            <KeyboardIcon />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Stream settings">
              <SlidersHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Image quality</DropdownMenuLabel>
            {QUALITIES.map((q) => (
              <DropdownMenuCheckboxItem
                key={q.value}
                checked={settings.quality === q.value}
                onCheckedChange={() => setSettings((s) => ({ ...s, quality: q.value }))}
              >
                {q.label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={settings.sharp}
              onCheckedChange={(sharp) => setSettings((s) => ({ ...s, sharp }))}
            >
              Sharp text (screen resolution)
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="Close browser" onClick={onClose}>
            <XIcon />
          </Button>
        )}
      </div>
      <div
        ref={viewportRef}
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden bg-[#0e1014]",
          focused && "after:pointer-events-none after:absolute after:inset-0 after:ring-1 after:ring-primary/40 after:ring-inset",
        )}
      >
        {page.loading && <div className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-primary" />}
        <canvas
          ref={canvasRef}
          className="absolute top-0 left-0 touch-none select-none"
          style={{ width: frameSize?.width, height: frameSize?.height, cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onContextMenu={(e) => e.preventDefault()}
        />
        <textarea
          ref={sinkRef}
          aria-label="Keyboard input for the page"
          className="pointer-events-none absolute top-0 left-0 size-px resize-none opacity-0"
          style={{ fontSize: 16 }}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onInput={onInput}
          onCompositionEnd={onCompositionEnd}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {connected && status === "connecting" && (
          <Overlay>
            <LoaderIcon className="size-4 animate-spin" />
            Starting browser…
          </Overlay>
        )}
        {connected && status === "live" && blank && !page.loading && (
          <Overlay className="pointer-events-none">Type a URL or a port (like 5173) above.</Overlay>
        )}
        {!connected && (
          <Overlay>
            <span>{error ?? "Disconnected from the browser."}</span>
            <Button variant="outline" size="sm" onClick={() => setAttachKey((k) => k + 1)}>
              Reconnect
            </Button>
          </Overlay>
        )}
        {notice && (
          <div className="absolute inset-x-2 bottom-2 z-10 rounded-md border bg-popover px-3 py-2 text-xs shadow-lg">
            {notice}
          </div>
        )}
      </div>
    </div>
  );
}

function Overlay({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
