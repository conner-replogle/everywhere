import {
  AppWindowIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LockIcon,
  MessageSquarePlusIcon,
  RotateCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type BrowserElement, WEBVIEW_DEVICE_PREF, type WebShortcut } from "@everywhere/protocol";
import {
  type Annotation,
  AnnotationBar,
  AnnotationCanvas,
  AnnotationComment,
  type AnnotationTool,
  annotationRect,
  composeAnnotations,
} from "@/components/browser/annotation-layer";
import { CenteredMessage } from "@/components/centered-message";
import { Button } from "@/components/ui/button";
import type { ComposerDraft } from "@/lib/composer-inbox";
import { desktop, onWebview, type WebviewElement } from "@/lib/desktop";
import { ELEMENT_JS } from "@/lib/page-elements";
import { addressToUrl, updateWebTab } from "@/lib/web-tabs";
import { cn, errorMessage } from "@/lib/utils";

/** Chrome's zoom steps. */
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const levelOf = (factor: number) => Math.log(factor) / Math.log(1.2);
const factorOf = (level: number) => 1.2 ** level;

const isMac = navigator.platform.startsWith("Mac");

export interface WebViewProps {
  deviceId: string;
  threadId: string;
  tabId: string;
  /** The page to show first (where the tab last was). */
  url: string;
  /** Shown in either side of a split. */
  shown: boolean;
  /** A page asked for a link in a new tab. */
  onOpenTab(url: string, background: boolean): void;
  onNewTab(): void;
  onClose(): void;
  /** Hands annotations to the chat; false if there's nowhere to put them. */
  onAnnotate?(draft: ComposerDraft): boolean;
}

/**
 * A web page in a tab. In the desktop app it's a page of its own (a
 * <webview>), with a browser's toolbar, keys and menus; a browser can't
 * show most sites inside another page, so there it says to use the app.
 */
export function WebView(props: WebViewProps) {
  if (!desktop) return <NeedsDesktop url={props.url} />;
  return <DesktopWebView {...props} />;
}

function NeedsDesktop({ url }: { url: string }) {
  const real = /^https?:/i.test(url);
  return (
    <CenteredMessage
      title="The Browser needs the desktop app"
      body="Most sites refuse to be shown inside another page, so a browser can't show them here. The Everywhere desktop app can."
    >
      <AppWindowIcon className="size-6 text-muted-foreground" />
      {real && (
        <Button variant="outline" size="sm" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
          <ExternalLinkIcon />
          Open {safeHost(url)} in a new tab
        </Button>
      )}
    </CenteredMessage>
  );
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

interface Failure {
  url: string;
  description: string;
}

/** The page held still to annotate: its screenshot, and its viewport in CSS pixels. */
interface Still {
  frame: HTMLCanvasElement;
  src: string;
  width: number;
  height: number;
  url: string;
  title: string;
}

function DesktopWebView({
  deviceId,
  threadId,
  tabId,
  url: initialUrl,
  shown,
  onOpenTab,
  onNewTab,
  onClose,
  onAnnotate,
}: WebViewProps) {
  const bridge = desktop!;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<WebviewElement | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [wcId, setWcId] = useState<number | null>(null);
  const [url, setUrl] = useState(initialUrl);
  const [address, setAddress] = useState(initialUrl === "about:blank" ? "" : initialUrl);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [zoom, setZoom] = useState(1);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [crashed, setCrashed] = useState(false);
  const [find, setFind] = useState<{ text: string; match: number; matches: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Callbacks change every render; the page's events use the latest.
  const latest = useRef({ onOpenTab, onNewTab, onClose, editing });
  latest.current = { onOpenTab, onNewTab, onClose, editing };

  // The <webview> is made once: moving or remaking it would reload the page.
  useEffect(() => {
    const host = hostRef.current!;
    const el = document.createElement("webview") as WebviewElement;
    el.setAttribute("partition", bridge.partition);
    // Its localhost is its device's (the desktop app reads this as the tab attaches).
    el.setAttribute("webpreferences", `${WEBVIEW_DEVICE_PREF}=${deviceId}`);
    el.setAttribute("allowpopups", "");
    el.setAttribute("src", initialUrl || "about:blank");
    el.style.cssText = "position:absolute;inset:0;display:flex";
    host.appendChild(el);
    viewRef.current = el;

    // The element's methods throw until its page is first ready.
    let ready = false;
    const syncNav = () => {
      if (!ready) return;
      setNav({ back: el.canGoBack(), forward: el.canGoForward() });
      setZoom(Math.round(factorOf(el.getZoomLevel()) * 100) / 100);
    };
    let origin = "";
    const page = (u: string) => {
      setUrl(u);
      if (!latest.current.editing) setAddress(u === "about:blank" ? "" : u);
      syncNav();
      if (u === "about:blank") return;
      // Another site's icon comes with its page; until then, none.
      const o = originOf(u);
      updateWebTab(deviceId, threadId, tabId, o === origin ? { url: u } : { url: u, icon: null });
      origin = o;
    };
    const offs = [
      onWebview(el, "dom-ready", () => {
        if (ready) return;
        ready = true;
        setWcId(el.getWebContentsId());
        syncNav();
      }),
      onWebview(el, "did-start-loading", () => {
        setLoading(true);
        setCrashed(false);
      }),
      onWebview(el, "did-stop-loading", () => {
        setLoading(false);
        syncNav();
      }),
      onWebview(el, "did-navigate", (e) => {
        setFailure(null);
        page(e.url);
      }),
      onWebview(el, "did-navigate-in-page", (e) => e.isMainFrame && page(e.url)),
      onWebview(el, "did-fail-load", (e) => {
        // -3: aborted (another navigation took its place)
        if (!e.isMainFrame || e.errorCode === -3) return;
        setFailure({ url: e.validatedURL, description: e.errorDescription });
        setUrl(e.validatedURL);
        if (!latest.current.editing) setAddress(e.validatedURL);
      }),
      onWebview(el, "page-title-updated", (e) => updateWebTab(deviceId, threadId, tabId, { title: e.title })),
      onWebview(el, "page-favicon-updated", (e) => {
        const src = e.favicons[0];
        if (!src) return;
        void bridge.favicon(src).then((icon) => updateWebTab(deviceId, threadId, tabId, { icon }));
      }),
      onWebview(el, "found-in-page", (e) =>
        setFind((f) => (f ? { ...f, match: e.result.activeMatchOrdinal, matches: e.result.matches } : f)),
      ),
      onWebview(el, "render-process-gone", () => setCrashed(true)),
    ];
    return () => {
      for (const off of offs) off();
      el.remove();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- made once per tab
  }, []);

  const view = () => viewRef.current;

  const setZoomTo = (factor: number) => {
    view()?.setZoomLevel(levelOf(factor));
    setZoom(factor);
  };
  const stepZoom = (dir: 1 | -1) => {
    const i = ZOOMS.findIndex((z) => z >= zoom - 0.001);
    const at = i < 0 ? ZOOMS.length - 1 : i;
    const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS[at]! > zoom + 0.001 && dir < 0 ? at - 1 : at + dir))]!;
    setZoomTo(next);
  };

  const focusAddress = () => {
    addressRef.current?.focus();
    addressRef.current?.select();
  };
  const openFind = () => {
    setFind((f) => f ?? { text: "", match: 0, matches: 0 });
    requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  };
  const closeFind = () => {
    view()?.stopFindInPage("clearSelection");
    setFind(null);
    view()?.focus();
  };

  const act = (action: WebShortcut) => {
    switch (action) {
      case "focus-address":
        return focusAddress();
      case "find":
        return openFind();
      case "new-tab":
        return latest.current.onNewTab();
      case "close-tab":
        return latest.current.onClose();
      case "zoom-in":
        return stepZoom(1);
      case "zoom-out":
        return stepZoom(-1);
      case "zoom-reset":
        return setZoomTo(1);
    }
  };
  const actRef = useRef(act);
  actRef.current = act;

  // What the page asks of the app: new tabs, and the app's keys pressed in it.
  useEffect(() => {
    if (wcId === null) return;
    return bridge.onWebEvent((e) => {
      if (e.from !== wcId) return;
      if (e.t === "open") latest.current.onOpenTab(e.url, e.background);
      else actRef.current(e.action);
    });
  }, [bridge, wcId]);

  // A new tab starts at its address bar.
  useEffect(() => {
    if (shown && url === "about:blank") requestAnimationFrame(focusAddress);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when it's shown
  }, [shown]);

  // The same keys with the toolbar focused (in the page, the desktop app sends them).
  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    let action: WebShortcut | null = null;
    if (mod && key === "l") action = "focus-address";
    else if (mod && key === "f") action = "find";
    else if (mod && key === "t") action = "new-tab";
    else if (mod && key === "w") action = "close-tab";
    else if (mod && (key === "=" || key === "+")) action = "zoom-in";
    else if (mod && key === "-") action = "zoom-out";
    else if (mod && key === "0") action = "zoom-reset";
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    act(action);
  };

  const go = (typed: string) => {
    const el = view();
    if (!el || !typed.trim()) return;
    const next = addressToUrl(typed);
    setEditing(false);
    setAddress(next);
    setFailure(null);
    void el.loadURL(next).catch(() => {});
    el.focus();
  };

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // --- annotations: marks on a still of the page, sent to the chat ---

  const [still, setStill] = useState<Still | null>(null);
  const [tool, setTool] = useState<AnnotationTool>("element");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [editingNote, setEditingNote] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const annotating = still !== null;

  useEffect(() => {
    const host = hostRef.current!;
    const ro = new ResizeObserver(() => setHostSize({ width: host.clientWidth, height: host.clientHeight }));
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const stopAnnotating = useCallback(() => {
    setStill(null);
    setAnnotations([]);
    setEditingNote(null);
  }, []);

  const startAnnotating = async () => {
    const el = view();
    if (!el || wcId === null) return;
    try {
      const [info, image] = await Promise.all([
        el.executeJavaScript("[innerWidth, innerHeight, document.title]") as Promise<[number, number, string]>,
        el.capturePage(),
      ]);
      if (image.isEmpty()) throw new Error("the page gave an empty picture");
      const src = image.toDataURL();
      const img = new Image();
      img.src = src;
      await img.decode();
      const frame = document.createElement("canvas");
      frame.width = img.naturalWidth;
      frame.height = img.naturalHeight;
      frame.getContext("2d")?.drawImage(img, 0, 0);
      setStill({ frame, src, width: info[0], height: info[1], url: el.getURL(), title: info[2] });
      setTool("element");
      setFind(null);
      hostRef.current?.focus({ preventScroll: true });
    } catch (e) {
      setNotice(`Couldn't hold the page still: ${errorMessage(e)}`);
    }
  };

  const pick = useCallback(async (x: number, y: number): Promise<BrowserElement | null> => {
    const el = viewRef.current;
    if (!el) return null;
    try {
      const code = `${ELEMENT_JS};\n(() => { const el = __ewDeepAt(${x}, ${y}); return el ? __ewDescribe(el) : null; })()`;
      return (await el.executeJavaScript(code)) as BrowserElement | null;
    } catch {
      return null;
    }
  }, []);

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
    if (!still || annotations.length === 0) return;
    setSending(true);
    try {
      const { file, text } = await composeAnnotations(still.frame, still, annotations, {
        intro: `Annotations on ${still.url}${still.title ? ` ("${still.title}")` : ""}, a page the user has open in the Everywhere app's Browser on their computer (not the browser your browser tools drive), viewport ${still.width}×${still.height}. The attached screenshot shows each numbered mark.`,
        name: "web-annotations",
      });
      if (onAnnotate?.({ text, files: [file] })) {
        stopAnnotating();
        return;
      }
      await navigator.clipboard.writeText(text);
      setNotice("Copied the annotations; there's no chat here to send them to.");
      stopAnnotating();
    } catch (e) {
      setNotice(`Couldn't send the annotations: ${errorMessage(e)}`);
    } finally {
      setSending(false);
    }
  };

  const noteIndex = annotations.findIndex((a) => a.id === editingNote);
  const note = noteIndex >= 0 ? annotations[noteIndex] : undefined;
  const scale = still && still.width ? hostSize.width / still.width : 1;

  const secure = /^https:/i.test(url);
  const local = /^http:\/\/(localhost|127\.|\[::1\]|[^/]+\.localhost)/i.test(url);
  const SiteIcon = secure ? LockIcon : /^http:/i.test(url) && !local ? TriangleAlertIcon : GlobeIcon;

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="relative flex h-9 shrink-0 items-center gap-0.5 border-b px-1.5">
        <Button variant="ghost" size="icon-sm" aria-label="Back" title="Back (Alt+←)" disabled={!nav.back} onClick={() => view()?.goBack()}>
          <ArrowLeftIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          title="Forward (Alt+→)"
          disabled={!nav.forward}
          onClick={() => view()?.goForward()}
        >
          <ArrowRightIcon />
        </Button>
        {loading ? (
          <Button variant="ghost" size="icon-sm" aria-label="Stop" title="Stop (Esc)" onClick={() => view()?.stop()}>
            <XIcon />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Reload"
            title="Reload (Ctrl+R)"
            onClick={(e) => (e.shiftKey ? view()?.reloadIgnoringCache() : view()?.reload())}
          >
            <RotateCwIcon />
          </Button>
        )}
        <form
          className="mx-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-muted/60 px-2 focus-within:bg-background focus-within:ring-1 focus-within:ring-ring"
          onSubmit={(e) => {
            e.preventDefault();
            go(address);
          }}
        >
          <SiteIcon
            className={cn("size-3.5 shrink-0", secure ? "text-muted-foreground" : "text-muted-foreground/70")}
            aria-label={secure ? "Secure connection" : "Not a secure connection"}
          />
          <input
            ref={addressRef}
            value={address}
            onChange={(e) => {
              setEditing(true);
              setAddress(e.target.value);
            }}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => {
              setEditing(false);
              setAddress(url === "about:blank" ? "" : url);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                setAddress(url === "about:blank" ? "" : url);
                view()?.focus();
              }
            }}
            placeholder="Search or type an address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Address"
            className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:font-sans placeholder:text-muted-foreground"
          />
        </form>
        {Math.abs(zoom - 1) > 0.001 && (
          <Button variant="ghost" size="sm" className="h-6 px-1.5 tabular-nums" title="Reset zoom (Ctrl+0)" onClick={() => setZoomTo(1)}>
            {Math.round(zoom * 100)}%
          </Button>
        )}
        <Button
          variant={annotating ? "secondary" : "ghost"}
          size="icon-sm"
          aria-label="Annotate"
          aria-pressed={annotating}
          title="Annotate the page for the chat"
          disabled={!annotating && (wcId === null || url === "about:blank" || !!failure || crashed)}
          onClick={() => (annotating ? stopAnnotating() : void startAnnotating())}
        >
          <MessageSquarePlusIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open in your browser"
          title="Open in your browser"
          disabled={!/^https?:/i.test(url)}
          onClick={() => bridge.openExternal(url)}
        >
          <ExternalLinkIcon />
        </Button>
        {loading && (
          <div className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden" aria-hidden>
            <div className="h-full w-1/3 animate-[web-loading_1.1s_ease-in-out_infinite] bg-primary" />
          </div>
        )}
      </div>
      <div ref={hostRef} tabIndex={-1} className="relative min-h-0 flex-1 bg-white outline-none">
        {still && (
          // Over the page, so nothing reaches it while annotating.
          <div className="absolute inset-0 z-[2] bg-background">
            <img src={still.src} alt="" draggable={false} className="pointer-events-none absolute inset-0 size-full select-none" />
            <AnnotationCanvas
              width={still.width}
              height={still.height}
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
            {note && (
              <AnnotationComment
                key={note.id}
                annotation={note}
                n={noteIndex + 1}
                left={annotationRect(note).x * scale}
                top={Math.min((annotationRect(note).y + annotationRect(note).height) * scale + 8, hostSize.height - 130)}
                maxWidth={hostSize.width}
                onChange={(comment) => setAnnotations((as) => as.map((a) => (a.id === note.id ? { ...a, comment } : a)))}
                onDelete={() => {
                  setAnnotations((as) => as.filter((a) => a.id !== note.id));
                  setEditingNote(null);
                }}
                onClose={() => setEditingNote(null)}
              />
            )}
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
          </div>
        )}
        {notice && (
          <div className="absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-md border bg-popover px-3 py-1.5 text-xs shadow-md">
            {notice}
          </div>
        )}
        {find && (
          <div className="absolute top-2 right-3 z-10 flex items-center gap-1 rounded-md border bg-popover p-1 pl-2 text-xs shadow-md">
            <input
              ref={findRef}
              value={find.text}
              onChange={(e) => {
                const text = e.target.value;
                setFind({ text, match: 0, matches: 0 });
                if (text) view()?.findInPage(text);
                else view()?.stopFindInPage("clearSelection");
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeFind();
                } else if (e.key === "Enter" && find.text) {
                  e.preventDefault();
                  view()?.findInPage(find.text, { findNext: true, forward: !e.shiftKey });
                }
              }}
              placeholder="Find in page"
              aria-label="Find in page"
              className="w-44 bg-transparent outline-none"
            />
            <span className="min-w-10 text-right text-muted-foreground tabular-nums">
              {find.text ? `${find.match}/${find.matches}` : ""}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous match"
              disabled={!find.text}
              onClick={() => view()?.findInPage(find.text, { findNext: true, forward: false })}
            >
              <ChevronUpIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next match"
              disabled={!find.text}
              onClick={() => view()?.findInPage(find.text, { findNext: true, forward: true })}
            >
              <ChevronDownIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Close find" onClick={closeFind}>
              <XIcon />
            </Button>
          </div>
        )}
        {url === "about:blank" && !loading && (
          <div className="absolute inset-0 z-[1] bg-background">
            <CenteredMessage title="New tab" body="Search, or type an address above (Ctrl+L)." />
          </div>
        )}
        {(failure || crashed) && (
          <div className="absolute inset-0 z-[1] bg-background">
            <CenteredMessage
              title={crashed ? "This page crashed" : `Couldn't load ${safeHost(failure!.url)}`}
              body={crashed ? undefined : failureHint(failure!)}
            >
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const el = view();
                  setFailure(null);
                  setCrashed(false);
                  if (failure) void el?.loadURL(failure.url).catch(() => {});
                  else el?.reload();
                }}
              >
                <RotateCwIcon />
                Try again
              </Button>
            </CenteredMessage>
          </div>
        )}
      </div>
    </div>
  );
}

function failureHint(f: Failure): string {
  const local = /^https?:\/\/(localhost|127\.|\[::1\]|[^/]+\.localhost)/i.test(f.url);
  if (local && /CONNECTION_REFUSED|EMPTY_RESPONSE|CONNECTION_CLOSED|TUNNEL/.test(f.description)) {
    return "Nothing answered on the device's port. Is the server running there? (localhost in the Browser is the thread's device.)";
  }
  return f.description.replace(/^net::/, "");
}
