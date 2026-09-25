import type {
  BrowserClientMsg,
  BrowserElement,
  BrowserState,
  BrowserTouchPoint,
  BrowserViewport,
} from "@everywhere/protocol";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  EllipsisVerticalIcon,
  KeyboardIcon,
  LoaderIcon,
  MessageSquarePlusIcon,
  MousePointer2Icon,
  PointerIcon,
  RotateCwIcon,
  TextCursorIcon,
  XIcon,
} from "lucide-react";
import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { BrowserVideo } from "@/lib/browser-video";
import type { DevicePeer } from "@/lib/peer";
import { cn, errorMessage } from "@/lib/utils";
import {
  type Annotation,
  AnnotationBar,
  AnnotationCanvas,
  AnnotationComment,
  type AnnotationTool,
  annotationRect,
  composeAnnotations,
} from "./annotation-layer";
import { DeviceBar } from "./device-bar";
import { useTrackpad } from "./trackpad";

interface Settings {
  quality: number;
  /** Render at the screen's pixel ratio (up to 2x) instead of 1x. */
  sharp: boolean;
  /** On touch screens: drive a pointer like a trackpad, so pages see hover. */
  mouse: boolean;
}

const SETTINGS_KEY = "ew.browser.settings";
const QUALITIES = [
  { label: "Low", value: 40 },
  { label: "Medium", value: 65 },
  { label: "High", value: 85 },
];
const DEFAULT_SETTINGS: Settings = { quality: 65, sharp: true, mouse: false };

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
/** Space around a device-sized page. */
const STAGE_PAD = 12;
/** Below this width the toolbar tucks back/forward into its menu. */
const NARROW_PX = 480;
const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
const canVideo = typeof RTCPeerConnection !== "undefined";
/** A failed video connection is retried this many times before JPEG takes over. */
const VIDEO_RETRIES = 3;

interface Stats {
  label: string;
  title: string;
}

interface AgentMark {
  action: string;
  x?: number;
  y?: number;
  label?: string;
  key: number;
}

export interface AnnotationDraft {
  text: string;
  files: File[];
}

/**
 * A Chromium tab running on the device, streamed as WebRTC video (or, from
 * browsers that can't, JPEG frames onto a canvas). Pointer, touch, wheel and
 * keyboard input go back over the channel; the page's cursor comes back as a
 * message and is applied to the picture.
 */
export function BrowserView({
  peer,
  threadId,
  generation,
  remoteOs,
  onClose,
  onAnnotate,
}: {
  peer: DevicePeer;
  /** The thread whose browser page this shows. */
  threadId: string;
  /** Peer connection generation; a new one means reopen the channel. */
  generation: number;
  remoteOs?: string;
  onClose?: () => void;
  /** Hands annotations to the chat; false if there's nowhere to put them. */
  onAnnotate?: (draft: AnnotationDraft) => boolean;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const videoElRef = useRef<HTMLVideoElement>(null);
  const videoRef = useRef<BrowserVideo | null>(null);
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
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [cursor, setCursor] = useState("default");
  const [notice, setNotice] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [attachKey, setAttachKey] = useState(0);
  const [agentMark, setAgentMark] = useState<AgentMark | null>(null);
  /** Showing video rather than JPEG frames; false once the device says it can't. */
  const [video, setVideo] = useState(canVideo);
  const videoOn = useRef(video);
  videoOn.current = video;
  /** While annotating video, the canvas holds a still of it. */
  const [still, setStill] = useState(false);
  const pageRef = useRef<BrowserState>(BLANK);
  const remoteMac = remoteOs === "darwin";
  const narrow = stage.width > 0 && stage.width < NARROW_PX;

  const send = useCallback((msg: BrowserClientMsg) => chanRef.current?.send(msg), []);

  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showNotice = useCallback((text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  }, []);
  const agentTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimeout(noticeTimer.current);
      clearTimeout(agentTimer.current);
    },
    [],
  );

  const viewport = useCallback((): BrowserViewport | null => {
    const s = sizeRef.current;
    if (!s || s.width < 1 || s.height < 1) return null;
    const { quality, sharp, mouse } = settingsRef.current;
    return { ...s, dpr: sharp ? Math.min(window.devicePixelRatio || 1, 2) : 1, quality, mobile: coarsePointer && !mouse };
  }, []);

  // --- picking --------------------------------------------------------------------

  const picks = useRef(new Map<number, (el: BrowserElement | null) => void>());
  const pickSeq = useRef(0);
  const pick = useCallback(
    (x: number, y: number) =>
      new Promise<BrowserElement | null>((resolve) => {
        const id = ++pickSeq.current;
        const timer = setTimeout(() => {
          picks.current.delete(id);
          resolve(null);
        }, 3000);
        picks.current.set(id, (el) => {
          clearTimeout(timer);
          resolve(el);
        });
        send({ t: "pick", id, x, y });
      }),
    [send],
  );

  // --- frames -----------------------------------------------------------------

  const counters = useRef({ frames: 0, bytes: 0 });
  const pendingFrame = useRef<{ hdr: BrowserFrameHeader; jpeg: Uint8Array<ArrayBuffer> } | null>(null);
  const decoding = useRef(false);
  /** While annotating, the picture holds still; the newest frame waits. */
  const frozen = useRef(false);

  // Decodes off the main thread and always draws the newest frame, skipping
  // any that arrived while the previous one was decoding.
  const pump = useCallback(() => {
    if (decoding.current || frozen.current || !pendingFrame.current) return;
    decoding.current = true;
    void (async () => {
      while (pendingFrame.current && !frozen.current) {
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

  const draw = useCallback(
    (hdr: BrowserFrameHeader, jpeg: Uint8Array<ArrayBuffer>) => {
      pendingFrame.current = { hdr, jpeg };
      pump();
    },
    [pump],
  );

  useEffect(() => {
    const id = setInterval(() => {
      const v = videoRef.current;
      if (videoOn.current && v) {
        void v.stats().then((st) => {
          if (!st) return;
          setStats({
            label: `${st.fps} fps · ${formatBits(st.bitsPerSec)}`,
            title: `${st.codec} video, ${st.width}×${st.height}`,
          });
        });
        return;
      }
      const { frames, bytes } = counters.current;
      counters.current = { frames: 0, bytes: 0 };
      setStats({
        label: `${frames} fps · ${formatBytes(bytes)}/s · ${formatBytes(frames ? bytes / frames : 0)}/frame`,
        title: `JPEG frames, quality ${settingsRef.current.quality}`,
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  /** The page's CSS size: the video carries none, so it comes from the tab's state. */
  const setPageSize = useCallback((width: number, height: number) => {
    const fs = frameSizeRef.current;
    if (!width || !height || (fs.width === width && fs.height === height)) return;
    frameSizeRef.current = { width, height };
    setFrameSize(frameSizeRef.current);
  }, []);

  // --- channel ----------------------------------------------------------------

  useEffect(() => {
    setStatus("connecting");
    setError(null);
    let chan: BrowserChannel;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const toJpeg = () => {
      videoRef.current?.close();
      videoRef.current = null;
      setVideo(false);
    };
    // Our side gave up on the video: attach again, asking for frames.
    const giveUp = () => {
      toJpeg();
      setAttachKey((k) => k + 1);
    };
    try {
      chan = peer.openBrowser(threadId, {
        onOpen: () => {
          const wantVideo = canVideo && videoOn.current;
          chan.send({
            t: "attach",
            ...(viewport() ?? { width: 800, height: 600, dpr: 1, quality: 65 }),
            video: wantVideo,
          });
          if (!wantVideo) return;
          const v = new BrowserVideo(
            (m) => chan.send(m),
            () => {
              if (++retries > VIDEO_RETRIES) {
                showNotice("Couldn't connect the video; showing still frames instead.");
                return giveUp();
              }
              retryTimer = setTimeout(() => void v.offer().catch(giveUp), 1000);
            },
          );
          videoRef.current = v;
          const el = videoElRef.current;
          if (el) el.srcObject = v.stream;
          v.offer().catch(giveUp);
        },
        onFrame: (hdr, jpeg) => {
          // A daemon from before video sends frames regardless.
          if (videoOn.current) toJpeg();
          counters.current.frames++;
          counters.current.bytes += hdr.size;
          setStatus("live");
          draw(hdr, jpeg);
        },
        onMessage: (msg) => {
          switch (msg.t) {
            case "state": {
              const { t: _, ...state } = msg;
              pageRef.current = state;
              setPage(state);
              if (videoOn.current && state.viewport) setPageSize(state.viewport.width, state.viewport.height);
              break;
            }
            case "answer":
              void videoRef.current?.onAnswer(msg.sdp).catch(giveUp);
              break;
            case "ice":
              videoRef.current?.onCandidate(msg.candidate);
              break;
            case "novideo":
              toJpeg();
              break;
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
            case "picked":
              picks.current.get(msg.id)?.(msg.element);
              picks.current.delete(msg.id);
              break;
            case "agent": {
              const { t: _, ...mark } = msg;
              setAgentMark({ ...mark, key: Date.now() });
              clearTimeout(agentTimer.current);
              agentTimer.current = setTimeout(() => setAgentMark(null), 3000);
              break;
            }
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
      clearTimeout(retryTimer);
      videoRef.current?.close();
      videoRef.current = null;
      chan.close();
      for (const done of picks.current.values()) done(null);
      picks.current.clear();
    };
  }, [peer, threadId, generation, attachKey, viewport, draw, showNotice, setPageSize]);

  // The video is live once it shows a frame, at the size the tab says it is.
  const onVideoFrame = () => {
    if (!videoOn.current) return;
    setStatus("live");
    const vp = pageRef.current.viewport;
    if (vp) setPageSize(vp.width, vp.height);
  };

  // The tab follows this view's size while it fills the panel.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const size = { width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) };
      sizeRef.current = size;
      setStage(size);
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

  // --- layout -------------------------------------------------------------------
  // Filling the panel, the page sits at the top left at its own size. A device
  // or fixed size is centred and shrunk to fit.

  const setting = page.viewport;
  const fixed = setting !== undefined && setting.mode !== "fill";
  const fs = frameSize ?? { width: stage.width, height: stage.height };
  const scale =
    fixed && fs.width && fs.height
      ? Math.min(1, (stage.width - STAGE_PAD * 2) / fs.width, (stage.height - STAGE_PAD * 2) / fs.height)
      : 1;
  const box = {
    width: fs.width * scale,
    height: fs.height * scale,
    left: fixed ? Math.max(STAGE_PAD, (stage.width - fs.width * scale) / 2) : 0,
    top: fixed ? Math.max(STAGE_PAD, (stage.height - fs.height * scale) / 2) : 0,
  };

  // --- pointer ------------------------------------------------------------------

  /** Client coordinates to the page's CSS pixels. */
  const toPage = useCallback((clientX: number, clientY: number) => {
    const c = surfaceRef.current;
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

  // Real touches, while the tab emulates a touch device.
  const touchMode = page.viewport?.mobile ?? false;
  const touches = useRef(new Map<number, BrowserTouchPoint>());
  const touchRaf = useRef(0);
  const touchPoints = () => [...touches.current.values()];
  const flushTouchMove = useCallback(() => {
    cancelAnimationFrame(touchRaf.current);
    touchRaf.current = 0;
    if (touches.current.size) send({ t: "touch", kind: "move", points: [...touches.current.values()] });
  }, [send]);

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

  const mouseMode = coarsePointer && settings.mouse;
  const trackpad = useTrackpad({
    enabled: mouseMode,
    send,
    pageSize: useCallback(() => frameSizeRef.current, []),
    screenPerPage: useCallback(() => {
      const r = surfaceRef.current?.getBoundingClientRect();
      const fs = frameSizeRef.current;
      return r && fs.width ? r.width / fs.width : 1;
    }, []),
  });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (mouseMode && e.pointerType === "touch") return trackpad.onPointerDown(e);
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = toPage(e.clientX, e.clientY);
    if (e.pointerType === "touch") {
      if (touchMode) {
        flushTouchMove();
        touches.current.set(e.pointerId, { id: e.pointerId, x, y });
        send({ t: "touch", kind: "start", points: touchPoints() });
        return;
      }
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

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (mouseMode && e.pointerType === "touch") return trackpad.onPointerMove(e);
    const { x, y } = toPage(e.clientX, e.clientY);
    if (e.pointerType === "touch") {
      if (touchMode) {
        if (!touches.current.has(e.pointerId)) return;
        touches.current.set(e.pointerId, { id: e.pointerId, x, y });
        if (!touchRaf.current) touchRaf.current = requestAnimationFrame(flushTouchMove);
        return;
      }
      const t = touch.current;
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

  const endTouch = (e: ReactPointerEvent<HTMLDivElement>, cancel: boolean) => {
    if (!touches.current.delete(e.pointerId)) return;
    flushTouchMove();
    // Lifting one finger of several is a move without it.
    if (touches.current.size) send({ t: "touch", kind: "move", points: touchPoints() });
    else send({ t: "touch", kind: cancel ? "cancel" : "end" });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (mouseMode && e.pointerType === "touch") return trackpad.onPointerUp(e);
    const { x, y } = toPage(e.clientX, e.clientY);
    if (e.pointerType === "touch") {
      if (touches.current.has(e.pointerId)) return endTouch(e, false);
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

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (mouseMode && e.pointerType === "touch") return trackpad.onPointerCancel(e);
    if (touches.current.has(e.pointerId)) endTouch(e, true);
    if (touch.current?.id === e.pointerId) touch.current = null;
  };

  // React's wheel listener is passive; this one has to be able to stop the
  // panel itself from scrolling.
  useEffect(() => {
    const c = surfaceRef.current;
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
      cancelAnimationFrame(touchRaf.current);
    },
    [],
  );

  // Dragging a freeform page's edges resizes it.
  const drag = useRef<{ x: number; y: number; w: number; h: number; scale: number; dir: "x" | "y" | "xy"; sent: number } | null>(
    null,
  );
  const [dragSize, setDragSize] = useState<{ width: number; height: number } | null>(null);
  const startResize = (dir: "x" | "y" | "xy") => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!setting) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, w: setting.width, h: setting.height, scale, dir, sent: 0 };
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // The page is centred, so an edge moves half as far as the size changes.
    const width = d.dir === "y" ? d.w : clampSize(d.w + (2 * (e.clientX - d.x)) / d.scale, 3840);
    const height = d.dir === "x" ? d.h : clampSize(d.h + (2 * (e.clientY - d.y)) / d.scale, 2160);
    setDragSize({ width, height });
    if (e.timeStamp - d.sent > 150) {
      d.sent = e.timeStamp;
      send({ t: "viewport", mode: "freeform", width, height });
    }
  };
  const endResize = () => {
    if (drag.current && dragSize) send({ t: "viewport", mode: "freeform", ...dragSize });
    drag.current = null;
    setDragSize(null);
  };

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

  // A phone's keyboard goes away when the page's text field loses focus.
  const wasEditing = useRef(false);
  useEffect(() => {
    const editing = page.editing ?? false;
    if (coarsePointer && wasEditing.current && !editing && document.activeElement === sinkRef.current) {
      sinkRef.current?.blur();
    }
    wasEditing.current = editing;
  }, [page.editing]);

  const toggleKeyboard = () => {
    const sink = sinkRef.current;
    if (!sink) return;
    if (document.activeElement === sink) sink.blur();
    else sink.focus({ preventScroll: true });
  };

  // --- annotations --------------------------------------------------------------

  const [annotating, setAnnotating] = useState(false);
  const [tool, setTool] = useState<AnnotationTool>("element");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [editingNote, setEditingNote] = useState<number | null>(null);
  const [sending, setSending] = useState(false);

  const stopAnnotating = useCallback(() => {
    setAnnotating(false);
    setAnnotations([]);
    setEditingNote(null);
    setStill(false);
    frozen.current = false;
    pump();
  }, [pump]);

  const startAnnotating = () => {
    frozen.current = true;
    // Hold the video still: its current frame goes onto the canvas.
    const v = videoElRef.current;
    const c = canvasRef.current;
    if (videoOn.current && v && c && v.videoWidth) {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d")?.drawImage(v, 0, 0);
      setStill(true);
    }
    sinkRef.current?.blur();
    setAnnotating(true);
    setTool(coarsePointer ? "region" : "element");
  };

  useEffect(() => {
    if (!annotating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (editingNote !== null) setEditingNote(null);
      else stopAnnotating();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [annotating, editingNote, stopAnnotating]);

  const sendAnnotations = async () => {
    const c = canvasRef.current;
    if (!c || !frameSize || annotations.length === 0) return;
    setSending(true);
    try {
      const { file, text } = await composeAnnotations(
        c,
        { ...frameSize, url: page.url, title: page.title },
        annotations,
      );
      if (onAnnotate?.({ text, files: [file] })) {
        stopAnnotating();
        return;
      }
      await navigator.clipboard.writeText(text);
      showNotice("Copied the annotations; there's no chat here to send them to.");
      stopAnnotating();
    } catch (e) {
      showNotice(`Couldn't send the annotations: ${errorMessage(e)}`);
    } finally {
      setSending(false);
    }
  };

  const noteIndex = annotations.findIndex((a) => a.id === editingNote);
  const note = noteIndex >= 0 ? annotations[noteIndex] : undefined;

  // --- toolbar ------------------------------------------------------------------

  const navigate = (e: FormEvent) => {
    e.preventDefault();
    if (draftUrl === null) return;
    send({ t: "navigate", url: normalizeUrl(draftUrl) });
    setDraftUrl(null);
    urlRef.current?.blur();
    if (!coarsePointer) sinkRef.current?.focus({ preventScroll: true });
  };

  const blank = page.url === "about:blank";
  const connected = status !== "closed" && !error;
  const iconBtn = "pointer-coarse:size-8";
  const scheme = page.colorScheme ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b bg-sidebar px-1.5 pointer-coarse:h-11">
        {!narrow && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              className={iconBtn}
              aria-label="Back"
              disabled={!page.canGoBack}
              onClick={() => send({ t: "back" })}
            >
              <ArrowLeftIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={iconBtn}
              aria-label="Forward"
              disabled={!page.canGoForward}
              onClick={() => send({ t: "forward" })}
            >
              <ArrowRightIcon />
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className={iconBtn}
          aria-label={page.loading ? "Stop" : "Reload"}
          onClick={() => send({ t: page.loading ? "stop" : "reload" })}
        >
          {page.loading ? <XIcon /> : <RotateCwIcon />}
        </Button>
        <form className="mx-1 min-w-20 flex-1" onSubmit={navigate}>
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
            enterKeyHint="go"
            // 16px on phones, so focusing it doesn't zoom the page.
            className="h-6 w-full rounded-sm border border-transparent bg-background px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-ring pointer-coarse:h-8 pointer-coarse:text-base"
          />
        </form>
        {stats && status === "live" && stage.width >= 720 && (
          <span
            className="shrink-0 px-1 font-mono text-[11px] text-muted-foreground tabular-nums"
            title={
              frameSize
                ? `${frameSize.width}×${frameSize.height} CSS px at ${viewport()?.dpr ?? 1}x; ${stats.title}`
                : stats.title
            }
          >
            {stats.label}
          </span>
        )}
        {coarsePointer && (
          <Button
            variant={mouseMode ? "secondary" : "ghost"}
            size="icon-sm"
            className={iconBtn}
            aria-label="Mouse mode"
            aria-pressed={mouseMode}
            title="Drive a mouse pointer like a trackpad, so the page sees hover"
            onClick={() => setSettings((s) => ({ ...s, mouse: !s.mouse }))}
          >
            <MousePointer2Icon />
          </Button>
        )}
        {coarsePointer && (
          <Button variant="ghost" size="icon-sm" className={iconBtn} aria-label="Keyboard" onClick={toggleKeyboard}>
            <KeyboardIcon />
          </Button>
        )}
        <Button
          variant={annotating ? "secondary" : "ghost"}
          size="icon-sm"
          className={iconBtn}
          aria-label="Annotate"
          aria-pressed={annotating}
          title="Annotate the page for the chat"
          disabled={status !== "live"}
          onClick={() => (annotating ? stopAnnotating() : startAnnotating())}
        >
          <MessageSquarePlusIcon />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className={iconBtn} aria-label="Browser options">
              <EllipsisVerticalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
          >
            {narrow && (
              <>
                <DropdownMenuItem disabled={!page.canGoBack} onSelect={() => send({ t: "back" })}>
                  <ArrowLeftIcon />
                  Back
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!page.canGoForward} onSelect={() => send({ t: "forward" })}>
                  <ArrowRightIcon />
                  Forward
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuLabel>Viewport</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={!fixed}
              onCheckedChange={() => send({ t: "viewport", mode: "fill" })}
            >
              Fill the panel
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={setting?.mode === "preset"}
              onCheckedChange={() =>
                send({ t: "viewport", mode: "preset", preset: setting?.preset ?? "iphone-12-pro" })
              }
            >
              Device…
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={setting?.mode === "freeform"}
              onCheckedChange={() =>
                send({
                  t: "viewport",
                  mode: "freeform",
                  width: setting?.width || 1280,
                  height: setting?.height || 800,
                })
              }
            >
              Custom size
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            {(
              [
                ["", "System"],
                ["light", "Light"],
                ["dark", "Dark"],
              ] as const
            ).map(([value, label]) => (
              <DropdownMenuCheckboxItem
                key={value}
                checked={scheme === value}
                onCheckedChange={() => send({ t: "appearance", colorScheme: value })}
              >
                {label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{video ? "Video quality" : "Image quality"}</DropdownMenuLabel>
            {QUALITIES.map((q) => (
              <DropdownMenuCheckboxItem
                key={q.value}
                checked={settings.quality === q.value}
                onCheckedChange={() => setSettings((s) => ({ ...s, quality: q.value }))}
              >
                {q.label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuCheckboxItem
              checked={settings.sharp}
              onCheckedChange={(sharp) => setSettings((s) => ({ ...s, sharp }))}
            >
              Sharp text (screen resolution)
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {onClose && (
          <Button variant="ghost" size="icon-sm" className={iconBtn} aria-label="Close browser" onClick={onClose}>
            <XIcon />
          </Button>
        )}
      </div>
      {fixed && setting && <DeviceBar viewport={dragSize ? { ...setting, ...dragSize } : setting} scale={scale} send={send} />}
      <div
        ref={stageRef}
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden",
          fixed ? "bg-muted/40" : "bg-[#0e1014]",
          focused && "after:pointer-events-none after:absolute after:inset-0 after:ring-1 after:ring-primary/40 after:ring-inset",
        )}
      >
        {page.loading && <div className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-primary" />}
        <div
          className={cn("absolute", fixed && "bg-[#0e1014] shadow-2xl ring-1 ring-border")}
          style={frameSize ? box : { left: 0, top: 0, width: 0, height: 0 }}
        >
          <div
            ref={surfaceRef}
            className="absolute inset-0 touch-none select-none"
            style={{ cursor: mouseMode ? "none" : cursor }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onContextMenu={(e) => e.preventDefault()}
          >
            {video && (
              <video
                ref={videoElRef}
                className="pointer-events-none absolute inset-0 size-full object-fill"
                autoPlay
                muted
                playsInline
                disablePictureInPicture
                onLoadedData={onVideoFrame}
                onResize={onVideoFrame}
              />
            )}
            <canvas
              ref={canvasRef}
              className={cn("pointer-events-none absolute inset-0 size-full", video && !still && "invisible")}
            />
            {mouseMode && frameSize && <RemotePointer cursor={cursor} dragging={trackpad.dragging} x={trackpad.pos.x * scale} y={trackpad.pos.y * scale} />}
          </div>
          {annotating && frameSize && (
            <AnnotationCanvas
              width={frameSize.width}
              height={frameSize.height}
              tool={tool}
              annotations={annotations}
              editing={editingNote}
              pick={pick}
              onAdd={(a) => setAnnotations((as) => [...as, a])}
              onUpdate={(id, patch) =>
                setAnnotations((as) => as.map((a) => (a.id === id ? ({ ...a, ...patch } as Annotation) : a)))
              }
              onEdit={setEditingNote}
            />
          )}
          {agentMark?.x !== undefined && agentMark.y !== undefined && frameSize && (
            <div
              className="pointer-events-none absolute z-10 transition-[left,top] duration-300"
              style={{ left: agentMark.x * scale, top: agentMark.y * scale }}
            >
              <span className="absolute -top-3 -left-3 size-6 animate-ping rounded-full bg-violet-500/40" />
              <MousePointer2Icon className="size-5 fill-violet-500 text-white drop-shadow" />
              <span className="absolute top-5 left-3 rounded bg-violet-600 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-white shadow">
                Claude · {agentMark.label || agentMark.action}
              </span>
            </div>
          )}
          {setting?.mode === "freeform" && !annotating && (
            <>
              <ResizeHandle dir="x" onDown={startResize("x")} onMove={onResizeMove} onUp={endResize} />
              <ResizeHandle dir="y" onDown={startResize("y")} onMove={onResizeMove} onUp={endResize} />
              <ResizeHandle dir="xy" onDown={startResize("xy")} onMove={onResizeMove} onUp={endResize} />
            </>
          )}
        </div>
        {annotating && note && frameSize && (
          <AnnotationComment
            key={note.id}
            annotation={note}
            n={noteIndex + 1}
            left={box.left + annotationRect(note).x * scale}
            top={Math.min(
              box.top + (annotationRect(note).y + annotationRect(note).height) * scale + 8,
              stage.height - 130,
            )}
            maxWidth={stage.width}
            onChange={(comment) =>
              setAnnotations((as) => as.map((a) => (a.id === note.id ? { ...a, comment } : a)))
            }
            onDelete={() => {
              setAnnotations((as) => as.filter((a) => a.id !== note.id));
              setEditingNote(null);
            }}
            onClose={() => setEditingNote(null)}
          />
        )}
        {annotating && (
          <AnnotationBar
            tool={tool}
            count={annotations.length}
            sending={sending}
            onTool={setTool}
            onUndo={() => {
              setAnnotations((as) => as.slice(0, -1));
              setEditingNote(null);
            }}
            onCancel={stopAnnotating}
            onSend={() => void sendAnnotations()}
          />
        )}
        {agentMark && agentMark.x === undefined && (
          <div className="pointer-events-none absolute top-2 right-2 z-10 flex items-center gap-1.5 rounded-full bg-violet-600 px-2.5 py-1 text-xs text-white shadow-lg">
            <BotIcon className="size-3.5" />
            Claude · {agentMark.label || agentMark.action}
          </div>
        )}
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
        {coarsePointer && page.editing && !focused && !annotating && connected && (
          <Button
            variant="secondary"
            className="absolute bottom-4 left-1/2 z-10 h-10 -translate-x-1/2 rounded-full px-4 shadow-lg"
            onClick={toggleKeyboard}
          >
            <KeyboardIcon className="size-4" />
            Type
          </Button>
        )}
        {connected && status === "connecting" && (
          <Overlay>
            <LoaderIcon className="size-4 animate-spin" />
            Starting browser…
          </Overlay>
        )}
        {connected && status === "live" && blank && !page.loading && !annotating && (
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
          <div className="absolute inset-x-2 bottom-2 z-30 rounded-md border bg-popover px-3 py-2 text-xs shadow-lg">
            {notice}
          </div>
        )}
      </div>
    </div>
  );
}

/** The trackpad's pointer, drawn where the page's mouse is, shaped like its cursor. */
function RemotePointer({ cursor, dragging, x, y }: { cursor: string; dragging: boolean; x: number; y: number }) {
  const shape = cursor === "pointer" ? "hand" : cursor === "text" || cursor === "vertical-text" ? "text" : "arrow";
  const Icon = shape === "hand" ? PointerIcon : shape === "text" ? TextCursorIcon : MousePointer2Icon;
  // Each icon's hot spot: the arrow's tip, the finger's tip, the beam's middle.
  const offset = shape === "hand" ? "-translate-x-[35%]" : shape === "text" ? "-translate-x-1/2 -translate-y-1/2" : "";
  return (
    <div className="pointer-events-none absolute z-10" style={{ left: x, top: y }}>
      <Icon
        className={cn(
          "size-5 text-black drop-shadow-[0_0_1.5px_white] transition-transform",
          shape === "arrow" && "fill-white",
          offset,
          dragging && "scale-90",
        )}
      />
    </div>
  );
}

function ResizeHandle({
  dir,
  onDown,
  onMove,
  onUp,
}: {
  dir: "x" | "y" | "xy";
  onDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onUp: () => void;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "absolute z-10 touch-none",
        dir === "x" && "top-0 -right-3 h-full w-3 cursor-ew-resize",
        dir === "y" && "-bottom-3 left-0 h-3 w-full cursor-ns-resize",
        dir === "xy" && "-right-3 -bottom-3 size-3 cursor-nwse-resize",
        "after:absolute after:rounded-full after:bg-muted-foreground/50 hover:after:bg-primary",
        dir === "x" && "after:top-1/2 after:left-1 after:h-8 after:w-1 after:-translate-y-1/2",
        dir === "y" && "after:top-1 after:left-1/2 after:h-1 after:w-8 after:-translate-x-1/2",
        dir === "xy" && "after:inset-0.5",
      )}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
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

function clampSize(v: number, most: number): number {
  return Math.round(Math.min(Math.max(v, 200), most));
}

function formatBits(n: number): string {
  if (n < 1e6) return `${Math.round(n / 1e3)} kbps`;
  return `${(n / 1e6).toFixed(1)} Mbps`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
