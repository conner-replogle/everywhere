// A PDF drawn with pdf.js, page by page as each scrolls into view. Not the
// browser's own viewer: phones have none to put in a frame, and our CSP
// (object-src 'none') keeps it out anyway.

import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/utils";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Gap between pages and around them, in CSS pixels. */
const GAP = 16;

export function PdfView({ bytes, zoom }: { bytes: Uint8Array<ArrayBuffer>; zoom: number }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PDFPageProxy[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // pdf.js hands the buffer to its worker, so give it a copy of ours.
    const task = getDocument({ data: bytes.slice() });
    let cancelled = false;
    task.promise
      .then(async (d) => {
        const ps = await Promise.all(Array.from({ length: d.numPages }, (_, i) => d.getPage(i + 1)));
        if (cancelled) return;
        setDoc(d);
        setPages(ps);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={box} className="min-h-full bg-terminal">
      {error ? (
        <p className="p-4 text-destructive">Couldn't read this PDF: {error}</p>
      ) : !doc ? (
        <p className="p-4 text-muted-foreground">Loading…</p>
      ) : (
        width > 0 && (
          <div className="flex min-w-max flex-col items-center" style={{ gap: GAP, padding: GAP }}>
            {pages.map((p) => (
              <PdfPage key={p.pageNumber} page={p} width={(width - 2 * GAP) * zoom} />
            ))}
          </div>
        )
      )}
    </div>
  );
}

/** One page at the given CSS width; drawn once it's near the viewport. */
function PdfPage({ page, width }: { page: PDFPageProxy; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(0.1, width / base.width);
  const height = base.height * scale;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e && setVisible(e.isIntersecting), { rootMargin: "100% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !visible) return;
    // Debounced so a resize or zoom redraws once it settles.
    let task: ReturnType<PDFPageProxy["render"]> | undefined;
    const t = setTimeout(() => {
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * dpr });
      el.width = Math.floor(viewport.width);
      el.height = Math.floor(viewport.height);
      task = page.render({ canvas: el, viewport });
      task.promise.catch(() => {}); // cancelled, or a page pdf.js can't draw
    }, 100);
    return () => {
      clearTimeout(t);
      task?.cancel();
    };
  }, [page, scale, visible]);

  return (
    <canvas
      ref={canvas}
      aria-label={`Page ${page.pageNumber}`}
      className="bg-white shadow-sm"
      style={{ width: Math.floor(width), height: Math.floor(height) }}
    />
  );
}
