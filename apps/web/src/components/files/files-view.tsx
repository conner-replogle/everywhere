// A files tab: browse a thread's working directory and read files in it.

import type { FsEntry } from "@everywhere/protocol";
import {
  ArrowLeftIcon,
  ChevronUpIcon,
  EyeIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
  RefreshCwIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type DevicePeer, useRpc } from "@/lib/peer";
import { cn, errorMessage } from "@/lib/utils";

const Markdown = lazy(() => import("@/components/agent/markdown").then((m) => ({ default: m.Markdown })));

/** What a files tab keeps in its tab state. */
interface FilesState {
  dir?: string;
  file?: string;
}

function parseState(raw: string | undefined): FilesState {
  try {
    return raw ? (JSON.parse(raw) as FilesState) : {};
  } catch {
    return {};
  }
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

const ext = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => path.slice(0, Math.max(1, path.lastIndexOf("/")));

/** Shows path relative to root when it's inside it. */
function relative(root: string, path: string): string {
  if (path === root) return baseName(root) || "/";
  if (path.startsWith(`${root}/`)) return `${baseName(root)}/${path.slice(root.length + 1)}`;
  return path;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function FilesView({
  peer,
  root,
  initialState,
  onStateChange,
}: {
  peer: DevicePeer;
  /** Where the thread works; the listing starts here. */
  root: string;
  initialState?: string;
  onStateChange?: (state: string) => void;
}) {
  const [{ dir = root, file }, setState] = useState<FilesState>(() => parseState(initialState));
  const [refresh, setRefresh] = useState(0);
  const listing = useRpc(peer, "fs.list", { path: dir }, []);

  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => onStateChangeRef.current?.(JSON.stringify({ dir, file })), 500);
    return () => clearTimeout(t);
  }, [dir, file]);

  const openDir = (path: string) => setState((s) => ({ ...s, dir: path }));
  const openFile = (path: string | undefined) => setState((s) => ({ ...s, file: path }));
  const reload = () => {
    listing.refetch();
    setRefresh((r) => r + 1);
  };

  return (
    <div className="flex h-full min-h-0">
      <div
        className={cn(
          "flex min-h-0 w-full flex-col border-r md:w-72 md:shrink-0",
          // On a phone the open file takes the whole tab.
          file && "max-md:hidden",
        )}
      >
        <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Parent directory"
            disabled={!listing.data?.parent}
            onClick={() => listing.data?.parent && openDir(listing.data.parent)}
          >
            <ChevronUpIcon />
          </Button>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={dir}>
            {relative(root, dir)}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={reload}>
            <RefreshCwIcon />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {listing.error ? (
            <p className="px-3 py-2 text-xs text-destructive">{listing.error}</p>
          ) : !listing.data ? null : listing.data.entries.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Empty directory</p>
          ) : (
            <ul>
              {listing.data.entries.map((e) => (
                <EntryRow
                  key={e.name}
                  entry={e}
                  selected={!e.dir && file === `${listing.data!.path}/${e.name}`}
                  onOpen={() => {
                    const path = `${listing.data!.path === "/" ? "" : listing.data!.path}/${e.name}`;
                    if (e.dir) openDir(path);
                    else openFile(path);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className={cn("min-h-0 min-w-0 flex-1", !file && "max-md:hidden")}>
        {file ? (
          <FileViewer key={`${file}:${refresh}`} peer={peer} root={root} path={file} onBack={() => openFile(undefined)} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">Pick a file to view it.</div>
        )}
      </div>
    </div>
  );
}

function EntryRow({ entry: e, selected, onOpen }: { entry: FsEntry; selected: boolean; onOpen: () => void }) {
  const Icon = e.dir ? FolderIcon : IMAGE_TYPES[ext(e.name)] ? ImageIcon : FileIcon;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] hover:bg-accent",
          selected && "bg-accent text-accent-foreground",
          e.name.startsWith(".") && "text-muted-foreground",
        )}
      >
        <Icon className={cn("size-3.5 shrink-0", e.dir ? "text-primary" : "text-muted-foreground")} />
        <span className="min-w-0 flex-1 truncate">{e.name}</span>
        {!e.dir && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatSize(e.size)}</span>}
      </button>
    </li>
  );
}

type Loaded =
  | { kind: "text"; text: string; size: number }
  | { kind: "image"; url: string; size: number }
  | { kind: "binary"; size: number };

/** Text is anything that decodes as UTF-8 with no NUL bytes near the start. */
function classify(path: string, bytes: Uint8Array<ArrayBuffer>): Loaded {
  const size = bytes.length;
  const image = IMAGE_TYPES[ext(path)];
  if (image) return { kind: "image", url: URL.createObjectURL(new Blob([bytes], { type: image })), size };
  if (bytes.subarray(0, 8000).includes(0)) return { kind: "binary", size };
  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), size };
  } catch {
    return { kind: "binary", size };
  }
}

function FileViewer({
  peer,
  root,
  path,
  onBack,
}: {
  peer: DevicePeer;
  root: string;
  path: string;
  onBack: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markdown = ext(path) === "md" || ext(path) === "markdown";
  const [preview, setPreview] = useState(markdown);

  useEffect(() => {
    const abort = new AbortController();
    let url: string | undefined;
    peer
      .readFile(path, abort.signal)
      .then(({ bytes }) => {
        const l = classify(path, bytes);
        if (l.kind === "image") url = l.url;
        if (abort.signal.aborted) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        setLoaded(l);
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(errorMessage(e));
      });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [peer, path]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2">
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Back to files" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground max-md:hidden" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
          {relative(root, dirName(path)) === relative(root, root) ? baseName(path) : relative(root, path)}
        </span>
        {loaded && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatSize(loaded.size)}</span>}
        {markdown && loaded?.kind === "text" && (
          <Button
            variant={preview ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Preview markdown"
            aria-pressed={preview}
            title="Preview"
            onClick={() => setPreview(!preview)}
          >
            <EyeIcon />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="p-4 text-destructive">{error}</p>
        ) : !loaded ? (
          <p className="p-4 text-muted-foreground">Loading…</p>
        ) : loaded.kind === "image" ? (
          <div className="flex min-h-full items-center justify-center bg-terminal p-4">
            <img src={loaded.url} alt={baseName(path)} className="max-h-full max-w-full object-contain" />
          </div>
        ) : loaded.kind === "binary" ? (
          <p className="p-4 text-muted-foreground">Binary file, not shown.</p>
        ) : preview ? (
          <div className="mx-auto max-w-3xl px-6 py-4 leading-relaxed">
            <Suspense>
              <Markdown text={loaded.text} />
            </Suspense>
          </div>
        ) : (
          <TextLines text={loaded.text} />
        )}
      </div>
    </div>
  );
}

function TextLines({ text }: { text: string }) {
  const gutter = useMemo(() => {
    const n = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return Array.from({ length: Math.max(1, n) }, (_, i) => i + 1).join("\n");
  }, [text]);
  return (
    <div className="flex min-h-full min-w-max bg-terminal font-mono text-xs leading-5">
      <pre
        aria-hidden
        className="sticky left-0 shrink-0 border-r bg-terminal px-3 py-2 text-right text-muted-foreground/60 select-none"
      >
        {gutter}
      </pre>
      <pre className="px-3 py-2">{text}</pre>
    </div>
  );
}
