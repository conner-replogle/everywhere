import type { DashboardBuild, Process } from "@everywhere/protocol";
import { LayoutDashboardIcon, OctagonAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type FileReply, type FrameTheme, type FromFrame, THEME_VARS, type ToFrame } from "@/dashboard/bridge";
import type { DevicePeer } from "@/lib/peer";
import { errorMessage } from "@/lib/utils";

/** How often an open dashboard checks for a new build. */
const POLL_MS = 1500;
/** How long the frame has to say it's ready before it's shown as stuck. */
const START_MS = 10_000;

function currentTheme(): FrameTheme {
  const style = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const name of THEME_VARS) vars[name] = style.getPropertyValue(name).trim();
  return { vars, dark: style.colorScheme !== "light" };
}

/**
 * A process's dashboard: the daemon builds .everywhere/dashboards/<name>,
 * and it runs in a sandboxed frame (/dashboard, dashboard.html) that gets the process,
 * its events, its files and its log from here. A new build reloads it.
 */
export function DashboardView({ peer, process: p }: { peer: DevicePeer; process: Process }) {
  const [build, setBuild] = useState<DashboardBuild | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useRef<string | undefined>(undefined);

  // Build it, then check for changes while it's on screen.
  useEffect(() => {
    let live = true;
    let timer = 0;
    version.current = undefined;
    setBuild(null);
    const check = async () => {
      if (document.visibilityState === "visible") {
        try {
          const b = await peer.call("processes.dashboard", { id: p.id, version: version.current }, 60_000);
          if (!live) return;
          setError(null);
          if (!b.unchanged) {
            version.current = b.version;
            setBuild(b);
          }
        } catch (e) {
          if (live) setError(errorMessage(e));
        }
      }
      if (live) timer = window.setTimeout(check, POLL_MS);
    };
    void check();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [peer, p.id, p.dashboard]);

  if (error && !build) return <Message title="Couldn't load the dashboard">{error}</Message>;
  if (!build) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        <LayoutDashboardIcon className="mr-2 size-4 animate-pulse" />
        Building {p.dashboard}…
      </div>
    );
  }
  if (build.errors?.length || !build.js) {
    return (
      <Message title={`${p.dashboard} doesn't build`}>
        <pre className="overflow-auto rounded-md border bg-card p-3 text-left font-mono text-[11px] whitespace-pre-wrap">
          {(build.errors ?? []).join("\n\n")}
        </pre>
        <span>Claude sees these with dashboard_build. It reloads here once it builds.</span>
      </Message>
    );
  }
  // A new build, or a new run of the process (its events start over), is a new frame.
  return <DashboardFrame key={`${build.version}:${p.startedAt}`} peer={peer} process={p} build={build} />;
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 overflow-auto p-6 text-center text-xs text-muted-foreground">
      <OctagonAlertIcon className="size-5 text-destructive" />
      <p className="font-medium text-foreground">{title}</p>
      <div className="grid max-w-2xl gap-2">{children}</div>
    </div>
  );
}

function DashboardFrame({ peer, process: p, build }: { peer: DevicePeer; process: Process; build: DashboardBuild }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setStuck(true), START_MS);
    return () => clearTimeout(t);
  }, [ready]);
  const processRef = useRef(p);
  processRef.current = p;

  const send = (msg: ToFrame, transfer?: Transferable[]) => {
    // The frame's origin is opaque, so "*"; it only ever gets its own process's data.
    frame.current?.contentWindow?.postMessage(msg, "*", transfer ?? []);
  };

  // Requests and errors from the frame.
  useEffect(() => {
    const onMessage = async (e: MessageEvent<FromFrame>) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const msg = e.data;
      const id = processRef.current.id;
      if (msg.t === "ready") {
        send({ t: "init", js: build.js!, css: build.css, process: processRef.current, theme: currentTheme() });
        setReady(true);
      } else if (msg.t === "error") {
        void peer.call("processes.dashboardError", { id, message: String(msg.message).slice(0, 2000) }).catch(() => {});
      } else if (msg.t === "request") {
        try {
          if (msg.method === "file") {
            const f = await peer.call("processes.file", { id, path: String(msg.params.path) });
            const { bytes } = await peer.readFile(f.path);
            // A file that shrank while read comes back as part of its buffer.
            const buffer = bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
            const result: FileReply = { bytes: buffer, type: f.type, size: f.size, modTime: f.modTime };
            send({ t: "reply", id: msg.id, result }, [buffer]);
          } else if (msg.method === "log") {
            const lines = await peer.call("processes.output", { id, tail: msg.params.tail, grep: msg.params.grep });
            send({ t: "reply", id: msg.id, result: lines });
          } else if (msg.method === "query") {
            const result = await peer.call("telemetry.query", { processId: id, query: msg.params.query });
            send({ t: "reply", id: msg.id, result });
          } else if (msg.method === "catalog") {
            const result = await peer.call("telemetry.catalog", { processId: id, experiment: msg.params.experiment });
            send({ t: "reply", id: msg.id, result });
          } else if (msg.method === "events") {
            const { experiment, runs, kind, limit } = msg.params;
            const result = await peer.call("telemetry.events", {
              processId: id,
              experiment: experiment ?? processRef.current.experiment ?? "",
              runs,
              kind,
              limit,
            });
            send({ t: "reply", id: msg.id, result });
          } else if (msg.method === "setState") {
            await peer.call("processes.setState", { id, key: String(msg.params.key), value: msg.params.value ?? null });
            send({ t: "reply", id: msg.id, result: null });
          }
        } catch (err) {
          send({ t: "reply", id: msg.id, error: errorMessage(err) });
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // build is fixed for this frame (a new one remounts it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peer]);

  // The process as it changes.
  useEffect(() => {
    if (ready) send({ t: "process", process: p });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, p]);

  // Its project's telemetry changing, so the dashboard's queries ask again.
  useEffect(() => {
    if (!ready || !p.home) return;
    return peer.onEvent((e) => {
      if (e.event === "telemetry.changed" && e.home === p.home) send({ t: "telemetry", experiments: e.experiments });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, peer, p.home]);

  // The theme, when the user changes it.
  useEffect(() => {
    if (!ready) return;
    const observer = new MutationObserver(() => send({ t: "theme", theme: currentTheme() }));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    return () => observer.disconnect();
  }, [ready]);

  if (stuck && !ready) {
    return (
      <Message title="The dashboard's page didn't start">
        <span>Its scripts didn't load. Reload the app; if it stays like this, the browser is refusing them.</span>
      </Message>
    );
  }
  return (
    <iframe
      ref={frame}
      src="/dashboard"
      title={`${p.dashboard} dashboard`}
      // Scripts only: an opaque origin, so it can't reach the app's storage or the device.
      sandbox="allow-scripts"
      className="h-full w-full border-0 bg-background"
    />
  );
}
