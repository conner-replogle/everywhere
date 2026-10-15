import type { AgentAttachment } from "@everywhere/protocol";
import { DownloadIcon, FileIcon, LoaderCircleIcon, PaperclipIcon, PlayIcon, RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DevicePeer } from "@/lib/peer";
import { cn, errorMessage } from "@/lib/utils";

/** Images up to this size load on their own; bigger ones wait for a click, like videos. */
const AUTO_IMAGE_BYTES = 15 << 20;

// A shared file's copy never changes (each share gets a folder of its own),
// so one fetch per path serves every time the timeline draws it.
const urls = new Map<string, Promise<string>>();

function fileURL(peer: DevicePeer, a: AgentAttachment): Promise<string> {
  const path = a.path!;
  let url = urls.get(path);
  if (!url) {
    url = peer.readFile(path).then(({ bytes }) => URL.createObjectURL(new Blob([bytes], { type: a.mediaType })));
    // A failed read can be tried again.
    url.catch(() => urls.delete(path));
    urls.set(path, url);
  }
  return url;
}

type Load = { state: "idle" } | { state: "loading" } | { state: "ready"; url: string } | { state: "error"; message: string };

/** Fetches a shared file from the device: now if auto, else when load() is called. */
function useFile(peer: DevicePeer | undefined, a: AgentAttachment, auto: boolean) {
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const start = useCallback(() => {
    if (!peer || !a.path) return;
    setLoad({ state: "loading" });
    fileURL(peer, a).then(
      (url) => setLoad({ state: "ready", url }),
      (e: unknown) => setLoad({ state: "error", message: errorMessage(e) }),
    );
  }, [peer, a]);
  useEffect(() => {
    if (auto) start();
  }, [auto, start]);
  return [load, start] as const;
}

/** Files the agent showed the user (attach_file): images inline, videos to play, anything else to download. */
export function SharedFiles({
  caption,
  attachments,
  peer,
}: {
  caption?: string;
  attachments: AgentAttachment[];
  peer?: DevicePeer;
}) {
  return (
    <div className="grid gap-2">
      {caption && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <PaperclipIcon className="size-3.5 shrink-0" />
          <span>{caption}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {attachments.map((a) =>
          a.kind === "image" ? (
            <SharedImage key={a.id} file={a} peer={peer} />
          ) : a.kind === "video" ? (
            <SharedVideo key={a.id} file={a} peer={peer} />
          ) : (
            <SharedFile key={a.id} file={a} peer={peer} />
          ),
        )}
      </div>
    </div>
  );
}

function SharedImage({ file: a, peer }: { file: AgentAttachment; peer?: DevicePeer }) {
  const [load, start] = useFile(peer, a, a.size <= AUTO_IMAGE_BYTES);
  if (load.state !== "ready") return <Placeholder file={a} load={load} onLoad={start} verb="Show" />;
  return (
    <a
      href={load.url}
      target="_blank"
      rel="noreferrer"
      title={`${a.name} · ${formatBytes(a.size)} — open full size`}
      className="block overflow-hidden rounded-md border bg-muted/30"
    >
      <img src={load.url} alt={a.name} className="max-h-96 max-w-full object-contain" />
    </a>
  );
}

function SharedVideo({ file: a, peer }: { file: AgentAttachment; peer?: DevicePeer }) {
  const [load, start] = useFile(peer, a, false);
  if (load.state !== "ready") return <Placeholder file={a} load={load} onLoad={start} verb="Play" video />;
  return (
    <div className="grid w-full max-w-2xl gap-1">
      <video src={load.url} controls autoPlay playsInline className="max-h-[70vh] w-full rounded-md border bg-black" />
      <FileLine file={a} url={load.url} />
    </div>
  );
}

function SharedFile({ file: a, peer }: { file: AgentAttachment; peer?: DevicePeer }) {
  const [load, start] = useFile(peer, a, false);
  // A download once fetched; the click that fetched it saves it too.
  const [want, setWant] = useState(false);
  useEffect(() => {
    if (want && load.state === "ready") {
      save(load.url, a.name);
      setWant(false);
    }
  }, [want, load, a.name]);
  return (
    <div className="flex h-12 max-w-80 min-w-56 items-center gap-2.5 rounded-md border px-2.5">
      <FileIcon className="size-5 shrink-0 text-muted-foreground" />
      <div className="grid min-w-0 flex-1">
        <span className="truncate text-[13px]" title={a.name}>
          {a.name}
        </span>
        <span className={cn("truncate text-[11px]", load.state === "error" ? "text-destructive" : "text-muted-foreground")}>
          {load.state === "error" ? load.message : `${formatBytes(a.size)} · ${a.mediaType}`}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Download ${a.name}`}
        title="Download"
        disabled={!peer || !a.path || load.state === "loading"}
        onClick={() => {
          if (load.state === "ready") save(load.url, a.name);
          else {
            setWant(true);
            start();
          }
        }}
      >
        {load.state === "loading" ? <LoaderCircleIcon className="animate-spin" /> : <DownloadIcon />}
      </Button>
    </div>
  );
}

/** An image or video not fetched yet: what it is, and a button to fetch it. */
function Placeholder({
  file: a,
  load,
  onLoad,
  verb,
  video,
}: {
  file: AgentAttachment;
  load: Load;
  onLoad: () => void;
  verb: string;
  video?: boolean;
}) {
  const Icon = load.state === "error" ? RotateCwIcon : video ? PlayIcon : DownloadIcon;
  return (
    <button
      type="button"
      onClick={onLoad}
      disabled={load.state === "loading"}
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-md border bg-muted/30 px-4 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        video ? "aspect-video w-full max-w-md" : "h-40 w-56",
      )}
      title={`${a.name} · ${formatBytes(a.size)}`}
    >
      {load.state === "loading" ? <LoaderCircleIcon className="size-6 animate-spin" /> : <Icon className="size-6" />}
      <span className="max-w-full truncate font-medium text-foreground/80">{a.name}</span>
      <span className={cn(load.state === "error" && "text-destructive")}>
        {load.state === "loading"
          ? `Loading ${formatBytes(a.size)}…`
          : load.state === "error"
            ? `${load.message} — click to retry`
            : `${verb} · ${formatBytes(a.size)}`}
      </span>
    </button>
  );
}

function FileLine({ file: a, url }: { file: AgentAttachment; url: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="min-w-0 truncate">{a.name}</span>
      <span className="shrink-0 tabular-nums">{formatBytes(a.size)}</span>
      <button type="button" onClick={() => save(url, a.name)} className="ml-auto shrink-0 hover:text-foreground">
        Download
      </button>
    </div>
  );
}

function save(url: string, name: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
}

function formatBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
