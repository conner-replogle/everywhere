import type { DesktopSource } from "@everywhere/protocol";
import {
  ActivityIcon,
  AppWindowIcon,
  LoaderIcon,
  MaximizeIcon,
  MinimizeIcon,
  MonitorIcon,
  MonitorOffIcon,
  PauseIcon,
  RotateCwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import { type DesktopConnection, connectDesktop } from "@/lib/desktop/connection";
import { InputForwarder } from "@/lib/desktop/input";
import {
  CODEC_NAMES,
  clipboard,
  type DesktopMode,
  EndReason,
  focusWindow,
  type Hello,
  MODE_LABELS,
  MODES,
  type ModeInfo,
  type OutputInfo,
  type PeerInfo,
  parseHost,
  ping,
  selectOutput,
  selectWindow,
  setClipSync,
  setFollow,
  setMode,
  Type,
  type WindowInfo,
  type WorkspaceInfo,
  workspace,
} from "@/lib/desktop/protocol";
import { type DesktopStats, DesktopStatsSampler } from "@/lib/desktop/stats";
import { type DevicePeer, useRpc } from "@/lib/peer";
import { cn, errorMessage } from "@/lib/utils";

interface Prefs {
  mode: DesktopMode;
  /** Show whichever monitor the desktop has focused (the Remote desktop page only). */
  follow: boolean;
  stats: boolean;
  /** Send Right Alt as Super, for browsers and desktops that keep the Super key. */
  superSub: boolean;
  /** Exchange clipboard text with the desktop. */
  clipboard: boolean;
}

const DEFAULT_PREFS: Prefs = { mode: "sharp", follow: true, stats: false, superSub: true, clipboard: true };

function loadPrefs(deviceId: string): Prefs {
  try {
    const raw = localStorage.getItem(`ew.desktop.${deviceId}`);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(deviceId: string, prefs: Prefs): void {
  try {
    localStorage.setItem(`ew.desktop.${deviceId}`, JSON.stringify(prefs));
  } catch {
    // Private windows can refuse storage; prefs just won't stick.
  }
}

/** A desktop tab's saved state: what it shows. */
interface TabState {
  source: DesktopSource;
}

function parseTabState(raw: string | undefined): TabState | null {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<TabState>) : null;
    return v?.source ? { source: v.source } : null;
  } catch {
    return null;
  }
}

function sourceOf(h: Hello): DesktopSource {
  return h.window ? { window: h.window, class: h.class, title: h.title } : { output: h.output };
}

const documentVisible = {
  subscribe: (fn: () => void) => {
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  },
  get: () => document.visibilityState === "visible",
};

type Status =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "paused" }
  | { kind: "interrupted" }
  | { kind: "ended"; message: string }
  | { kind: "error"; message: string };

export interface DesktopViewProps {
  peer: DevicePeer;
  deviceId: string;
  deviceName: string;
  /**
   * A desktop tab shows one monitor or window, saved in its state, and
   * doesn't follow focus. Without one, this is the Remote desktop page: the
   * whole desktop, with workspaces.
   */
  tab?: { id: string; state?: string; onStateChange: (state: string) => void };
  /** False while the tab is in the background: the session pauses. */
  active?: boolean;
}

/**
 * The device's logged-in desktop: a low-latency video of a monitor or window
 * with mouse, keyboard and clipboard going back. Keys are captured while the
 * picture has focus; fullscreen also captures system keys (Super, Alt+Tab,
 * Esc) in Chromium.
 */
export function DesktopView(props: DesktopViewProps) {
  const { peer, deviceName } = props;
  const info = useRpc(peer, "desktop.info", {});
  const ready = info.data?.enabled && info.data.available;

  if (!info.data) {
    return (
      <Message icon={<LoaderIcon className="size-5 animate-spin text-muted-foreground" />} title="Checking remote desktop…">
        {info.error && <p className="font-mono text-xs">{info.error}</p>}
      </Message>
    );
  }
  if (!ready) {
    return (
      <Message
        icon={<MonitorOffIcon className="size-5 text-muted-foreground" />}
        title={info.data.enabled ? "Remote desktop isn't available" : "Remote desktop is off"}
        action={
          <Button variant="outline" size="sm" onClick={info.refetch}>
            <RotateCwIcon />
            Check again
          </Button>
        }
      >
        {info.data.enabled ? (
          <p>{info.data.reason}</p>
        ) : (
          <>
            <p>
              For safety, remote desktop has to be turned on at {deviceName} itself. Run this there, then check again:
            </p>
            <code className="rounded bg-terminal px-2 py-1 font-mono text-xs text-foreground">
              everywhere desktop enable
            </code>
          </>
        )}
      </Message>
    );
  }
  return <DesktopSession {...props} />;
}

function DesktopSession({ peer, deviceId, tab, active = true }: DesktopViewProps) {
  const [prefs, setPrefs] = useState(() => loadPrefs(deviceId));
  const updatePrefs = (patch: Partial<Prefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(deviceId, next);
      return next;
    });
  const follow = !tab && prefs.follow;

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const connRef = useRef<DesktopConnection | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [hello, setHello] = useState<Hello | null>(null);
  const [outputs, setOutputs] = useState<OutputInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [modeInfo, setModeInfo] = useState<ModeInfo | null>(null);
  const [path, setPath] = useState<PeerInfo | null>(null);
  const [stats, setStats] = useState<DesktopStats | null>(null);
  const [inputRtt, setInputRtt] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const reconnect = useCallback(() => setAttempt((a) => a + 1), []);

  // Nothing streams while nobody can see it: a background tab, or a hidden page.
  const pageVisible = useSyncExternalStore(documentVisible.subscribe, documentVisible.get);
  const visible = active && pageVisible;

  // Read at connect time; later changes go over the open session.
  const connectRef = useRef({ mode: prefs.mode, follow, clipboard: prefs.clipboard, tab });
  connectRef.current = { mode: prefs.mode, follow, clipboard: prefs.clipboard, tab };
  // What the tab shows, saved as the host reports it.
  const tabSource = useRef<DesktopSource | undefined>(parseTabState(tab?.state)?.source);
  // Clipboard text both sides have, and host text waiting for this page to have focus.
  const clip = useRef<{ last: string | null; pending: string | null }>({ last: null, pending: null });
  const superSub = prefs.superSub;

  useEffect(() => {
    const video = videoRef.current;
    const stage = stageRef.current;
    if (!video || !stage) return;
    if (!visible) {
      setStatus({ kind: "paused" });
      return;
    }
    let cancelled = false;
    let endedByHost = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const timers: ReturnType<typeof setInterval>[] = [];
    let forwarder: InputForwarder | null = null;
    setStatus({ kind: "connecting" });

    // Deferred a tick: React's development double-mount would otherwise start
    // two sessions, the second taking over from the first.
    const start = setTimeout(async () => {
      const opts = connectRef.current;
      let conn: DesktopConnection;
      try {
        conn = await connectDesktop(peer, {
          mode: opts.mode,
          source: opts.tab ? tabSource.current : undefined,
          tabId: opts.tab?.id,
          onState: (st) => {
            if (cancelled || endedByHost) return;
            if (st === "connected") setStatus({ kind: "live" });
            else if (st === "disconnected") setStatus({ kind: "interrupted" });
            else if (st === "failed" || st === "closed") {
              setStatus({ kind: "error", message: "Connection lost. Reconnecting…" });
              retry = setTimeout(reconnect, 2000);
            }
          },
        });
      } catch (e) {
        if (!cancelled) setStatus({ kind: "error", message: errorMessage(e) });
        return;
      }
      if (cancelled) {
        conn.close();
        return;
      }
      connRef.current = conn;
      video.srcObject = conn.stream;
      forwarder = new InputForwarder(video, conn, { superSubstitute: superSub ? "AltRight" : null, keyTarget: stage });
      stage.focus({ preventScroll: true });
      const onOpen = () => {
        conn.control.send(setFollow(connectRef.current.follow));
        conn.control.send(setClipSync(connectRef.current.clipboard));
      };
      if (conn.control.readyState === "open") onOpen();
      else conn.control.addEventListener("open", onOpen, { once: true });

      conn.control.onmessage = (ev) => {
        const msg = parseHost(ev.data as ArrayBuffer);
        switch (msg?.type) {
          case Type.Hello: {
            setHello(msg);
            const t = connectRef.current.tab;
            const src = sourceOf(msg);
            if (t && JSON.stringify(src) !== JSON.stringify(tabSource.current)) {
              tabSource.current = src;
              t.onStateChange(JSON.stringify({ source: src } satisfies TabState));
            }
            break;
          }
          case Type.Pong:
            setInputRtt(performance.now() - msg.clientMs);
            break;
          case Type.Outputs:
            setOutputs(msg.outputs);
            break;
          case Type.Workspaces:
            setWorkspaces(msg.workspaces);
            break;
          case Type.Windows:
            setWindows(msg.windows);
            break;
          case Type.HostClipboard:
            clip.current.last = msg.text;
            if (connectRef.current.clipboard) writeLocalClipboard(msg.text);
            break;
          case Type.ModeInfo:
            setModeInfo(msg);
            break;
          case Type.PeerInfo:
            setPath(msg);
            break;
          case Type.SessionEnded:
            endedByHost = true;
            forwarder?.dispose();
            forwarder = null;
            setStatus({
              kind: "ended",
              message:
                msg.reason === EndReason.TakenOver
                  ? `${msg.detail || "Another viewer"} took over this desktop.`
                  : msg.reason === EndReason.HostShutdown
                    ? "The daemon on this device stopped."
                    : `Capture failed: ${msg.detail}`,
            });
            break;
        }
      };

      let seq = 0;
      timers.push(
        setInterval(() => {
          if (conn.control.readyState === "open") conn.control.send(ping(seq++, performance.now()));
        }, 1000),
      );
      const sampler = new DesktopStatsSampler(conn.pc);
      timers.push(
        setInterval(() => {
          void sampler.sample().then((s) => {
            if (!cancelled && s) setStats(s);
          });
        }, 1000),
      );
    });

    // Unmounting doesn't happen when the tab closes or navigates away; say
    // goodbye so the daemon stops capturing now rather than after ICE times out.
    const onPageHide = () => connRef.current?.close();
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      cancelled = true;
      clearTimeout(start);
      clearTimeout(retry);
      for (const t of timers) clearInterval(t);
      forwarder?.dispose();
      connRef.current?.close();
      connRef.current = null;
      video.srcObject = null;
    };
  }, [peer, attempt, superSub, reconnect, visible]);

  const sendControl = useCallback((msg: ArrayBuffer) => {
    const c = connRef.current?.control;
    if (c?.readyState === "open") c.send(msg);
  }, []);

  // Clipboard. The host's text is written here when it changes (once this
  // page has focus, which writing needs). Ours goes to the host when the
  // viewer comes back from another app or clicks into the picture, which is
  // when they've likely copied something to paste there.
  const writeLocalClipboard = (text: string) => {
    if (!document.hasFocus()) {
      clip.current.pending = text;
      return;
    }
    navigator.clipboard?.writeText(text).catch(() => {
      clip.current.pending = text;
    });
  };
  const syncClipboardToHost = useCallback(async () => {
    if (!connectRef.current.clipboard || !navigator.clipboard?.readText) return;
    const text = await navigator.clipboard.readText().catch(() => null);
    if (text === null || text === "" || text === clip.current.last) return;
    const msg = clipboard(text);
    if (!msg) return;
    clip.current.last = text;
    sendControl(msg);
  }, [sendControl]);
  useEffect(() => {
    const onFocus = () => {
      const pending = clip.current.pending;
      if (pending !== null && connectRef.current.clipboard) {
        clip.current.pending = null;
        navigator.clipboard?.writeText(pending).catch(() => {});
        return;
      }
      if (document.activeElement === stageRef.current) void syncClipboardToHost();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [syncClipboardToHost]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      return;
    }
    await rootRef.current?.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    // Keyboard Lock sends Super, Alt+Tab and Esc to the page (Chromium, secure contexts).
    const kb = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void> } }).keyboard;
    await kb?.lock?.().catch(() => {});
    stageRef.current?.focus({ preventScroll: true });
  };

  const focusStage = () => stageRef.current?.focus({ preventScroll: true });
  const streamingWindow = !!hello?.window;
  const activeOutput = streamingWindow ? undefined : outputs.find((o) => o.active);
  const iconBtn = "pointer-coarse:size-8";
  const overlay =
    status.kind === "live" || status.kind === "paused"
      ? null
      : status.kind === "connecting"
        ? "Connecting…"
        : status.kind === "interrupted"
          ? "Connection interrupted…"
          : status.message;

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col bg-background">
      {/* In fullscreen the toolbar hides above the screen; pointing at the top edge brings it back. */}
      <div className={fullscreen ? "group absolute inset-x-0 top-0 z-20 h-1.5" : "contents"}>
        <div
          data-local-keys
          className={cn(
            "flex h-9 shrink-0 items-center gap-0.5 border-b bg-sidebar px-1.5 pointer-coarse:h-11",
            fullscreen &&
              "-translate-y-full transition-transform group-focus-within:translate-y-0 group-hover:translate-y-0",
          )}
        >
          <SourceMenu
            hello={hello}
            outputs={outputs}
            windows={windows}
            page={!tab}
            follow={follow}
            onFollow={(on) => {
              updatePrefs({ follow: on });
              sendControl(setFollow(on));
            }}
            onOutput={(name) => sendControl(selectOutput(name))}
            onWindow={(id) => {
              sendControl(tab ? selectWindow(id) : focusWindow(id));
              focusStage();
            }}
          />
          {!streamingWindow && workspaces.length > 0 && (
            <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto px-1" role="group" aria-label="Workspaces">
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className={cn(
                    "flex h-6 min-w-6 shrink-0 items-center justify-center rounded px-1.5 text-xs tabular-nums pointer-coarse:h-8 pointer-coarse:min-w-8",
                    w.active && w.monitor === activeOutput?.name
                      ? "bg-primary text-primary-foreground"
                      : w.active
                        ? "text-foreground ring-1 ring-border ring-inset hover:bg-accent"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                  title={`Workspace ${w.name} on ${w.monitor} · ${w.windows} window${w.windows === 1 ? "" : "s"}`}
                  aria-pressed={w.active && w.monitor === activeOutput?.name}
                  onClick={() => {
                    sendControl(workspace(w.id));
                    focusStage();
                  }}
                >
                  {w.name}
                </button>
              ))}
            </div>
          )}
          {modeInfo && (
            <span className="hidden truncate px-1 text-xs text-muted-foreground lg:inline">
              {MODE_LABELS[modeInfo.mode]} · {CODEC_NAMES[modeInfo.codec] ?? "?"} · {(modeInfo.bitrateKbps / 1000).toFixed(1)}{" "}
              Mbps
            </span>
          )}
          {path?.relayed && (
            <span
              className="truncate px-1 text-xs text-warn"
              title="Traffic is relayed rather than direct, which adds latency. Low bandwidth mode may help."
            >
              Relayed ({path.relay})
            </span>
          )}
          <div className="flex-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className={iconBtn} aria-label="Quality, keys and clipboard">
                <SlidersHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Quality</DropdownMenuLabel>
              {MODES.map((m) => (
                <DropdownMenuCheckboxItem
                  key={m}
                  checked={prefs.mode === m}
                  onCheckedChange={() => {
                    updatePrefs({ mode: m });
                    sendControl(setMode(m));
                  }}
                >
                  {MODE_LABELS[m]}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={prefs.superSub} onCheckedChange={(on) => updatePrefs({ superSub: on })}>
                Right Alt sends Super
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={prefs.clipboard}
                onCheckedChange={(on) => {
                  updatePrefs({ clipboard: on });
                  sendControl(setClipSync(on));
                }}
              >
                Share clipboard
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(iconBtn, prefs.stats && "text-primary")}
            aria-label="Stats"
            aria-pressed={prefs.stats}
            onClick={() => updatePrefs({ stats: !prefs.stats })}
          >
            <ActivityIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" className={iconBtn} aria-label="Reconnect" onClick={reconnect}>
            <RotateCwIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={iconBtn}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen (also sends Super, Alt+Tab and Esc to the desktop)"}
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
          </Button>
        </div>
      </div>
      <div
        ref={stageRef}
        tabIndex={-1}
        className="relative min-h-0 flex-1 overflow-hidden bg-black outline-none"
        onPointerDown={() => {
          if (document.activeElement !== stageRef.current) {
            focusStage();
            void syncClipboardToHost();
          }
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          disablePictureInPicture
          className="size-full cursor-none touch-none object-contain select-none"
        />
        {status.kind === "paused" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <PauseIcon className="size-5 text-muted-foreground" />
          </div>
        )}
        {overlay && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
            <div className="flex max-w-md flex-col items-center gap-3 rounded-lg bg-background/85 px-4 py-3 text-center text-sm">
              {status.kind === "connecting" || status.kind === "interrupted" ? (
                <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
              ) : null}
              <p>{overlay}</p>
              {(status.kind === "ended" || status.kind === "error") && (
                <Button variant="outline" size="sm" className="pointer-events-auto" onClick={reconnect}>
                  <RotateCwIcon />
                  {status.kind === "ended" ? "Take it back" : "Try again"}
                </Button>
              )}
            </div>
          </div>
        )}
        {prefs.stats && stats && (
          <pre className="pointer-events-none absolute top-2 left-2 rounded bg-black/70 px-2 py-1.5 font-mono text-[11px] leading-snug text-white/90">
            {formatStats(stats, inputRtt)}
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * Picks what to show: a monitor, or (in a tab) one window. On the Remote
 * desktop page the window list jumps to a window instead, and the view can
 * follow the focused monitor.
 */
function SourceMenu({
  hello,
  outputs,
  windows,
  page,
  follow,
  onFollow,
  onOutput,
  onWindow,
}: {
  hello: Hello | null;
  outputs: OutputInfo[];
  windows: WindowInfo[];
  page: boolean;
  follow: boolean;
  onFollow: (on: boolean) => void;
  onOutput: (name: string) => void;
  onWindow: (id: string) => void;
}) {
  const streamingWindow = !!hello?.window;
  const label = streamingWindow ? hello.class || hello.title || "Window" : hello?.output || "Monitor";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="max-w-56 min-w-0 gap-1.5 px-2 font-normal"
          disabled={!hello}
          title={streamingWindow ? `${hello.title} (${hello.class})` : undefined}
        >
          {streamingWindow ? <AppWindowIcon /> : <MonitorIcon />}
          <span className="truncate">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[70vh] max-w-96 overflow-y-auto">
        {page && (
          <>
            <DropdownMenuCheckboxItem checked={follow} onCheckedChange={onFollow}>
              Follow focused monitor
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Monitors</DropdownMenuLabel>
        {outputs.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.name}
            checked={!streamingWindow && o.active}
            onCheckedChange={() => onOutput(o.name)}
          >
            {o.name}
            <span className="ml-auto pl-4 text-xs text-muted-foreground">
              {o.width}×{o.height}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        {windows.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{page ? "Go to window" : "Windows"}</DropdownMenuLabel>
            {windows.map((w) =>
              page ? (
                <DropdownMenuItem key={w.id} onSelect={() => onWindow(w.id)}>
                  <WindowLabel w={w} />
                </DropdownMenuItem>
              ) : (
                <DropdownMenuCheckboxItem
                  key={w.id}
                  checked={hello?.window === w.id}
                  onCheckedChange={() => onWindow(w.id)}
                >
                  <WindowLabel w={w} />
                </DropdownMenuCheckboxItem>
              ),
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WindowLabel({ w }: { w: WindowInfo }) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2" title={`${w.title} · workspace ${w.workspace} on ${w.monitor}`}>
      <span className={cn("shrink-0", w.focused && "font-medium")}>{w.class || "Window"}</span>
      <span className="truncate text-xs text-muted-foreground">{w.title}</span>
      <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground tabular-nums">{w.workspace}</span>
    </span>
  );
}

function formatStats(s: DesktopStats, inputRtt: number | null): string {
  const ms = (v: number | null) => (v == null ? "  -" : v.toFixed(1).padStart(5)) + " ms";
  return [
    `codec     ${s.codec}`,
    `video     ${s.width}×${s.height} @ ${s.fps.toFixed(0)} fps`,
    `bitrate   ${s.bitrateMbps.toFixed(2)} Mbps`,
    `rtt       ${ms(s.rttMs)}`,
    `input rtt ${ms(inputRtt)}`,
    `jitterbuf ${ms(s.jitterBufferMs)}`,
    `decode    ${ms(s.decodeMs)}`,
    `recv→out  ${ms(s.processingMs)}`,
    `dropped   ${s.framesDropped}   lost ${s.packetsLost}`,
    `path      ${s.path}`,
  ].join("\n");
}

function Message({
  icon,
  title,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {icon}
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <div className="grid justify-items-center gap-2 text-muted-foreground">{children}</div>
        {action}
      </div>
    </div>
  );
}
