import type { BrowserElement } from "@everywhere/protocol";
import { MousePointerClickIcon, PenLineIcon, SendIcon, SquareDashedIcon, Trash2Icon, Undo2Icon, XIcon } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Annotations mark up a frozen frame of the page: elements (described by the
// page), regions and freehand strokes, each with a comment. They're sent to
// the chat as one screenshot with numbered marks plus a text summary.

export type AnnotationTool = "element" | "region" | "draw";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

export type Annotation = { id: number; comment: string } & (
  | { kind: "element"; element: BrowserElement }
  /** element: what the region is mostly over, for context. */
  | { kind: "region"; rect: Rect; element: BrowserElement | null }
  | { kind: "draw"; points: Point[]; rect: Rect; element: BrowserElement | null }
);

/** Page CSS pixels. */
export function annotationRect(a: Annotation): Rect {
  return a.kind === "element" ? a.element : a.rect;
}

const MARK = "#f43f5e";
const TOOLS: { tool: AnnotationTool; label: string; icon: typeof PenLineIcon }[] = [
  { tool: "element", label: "Pick elements", icon: MousePointerClickIcon },
  { tool: "region", label: "Mark a region", icon: SquareDashedIcon },
  { tool: "draw", label: "Draw", icon: PenLineIcon },
];

/**
 * The marks, drawn over the frame. Width/height are the page's CSS size; the
 * SVG scales with the canvas it covers.
 */
export function AnnotationCanvas({
  width,
  height,
  tool,
  annotations,
  editing,
  pick,
  onAdd,
  onUpdate,
  onEdit,
}: {
  width: number;
  height: number;
  tool: AnnotationTool;
  annotations: Annotation[];
  editing: number | null;
  pick: (x: number, y: number) => Promise<BrowserElement | null>;
  onAdd: (a: Annotation) => void;
  onUpdate: (id: number, patch: Partial<Annotation>) => void;
  onEdit: (id: number | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<BrowserElement | null>(null);
  const [draft, setDraft] = useState<{ start: Point; points: Point[] } | null>(null);
  const nextId = useRef(1);
  useEffect(() => {
    nextId.current = Math.max(nextId.current, ...annotations.map((a) => a.id + 1));
  }, [annotations]);

  // One pick in flight at a time; the newest point wins.
  const picking = useRef<{ busy: boolean; next: Point | null }>({ busy: false, next: null });
  const hoverAt = (p: Point) => {
    const q = picking.current;
    q.next = p;
    if (q.busy) return;
    q.busy = true;
    void (async () => {
      while (q.next) {
        const at = q.next;
        q.next = null;
        setHover(await pick(at.x, at.y));
      }
      q.busy = false;
    })();
  };
  useEffect(() => setHover(null), [tool]);

  const toPage = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return { x: 0, y: 0 };
    return {
      x: Math.min(Math.max(((e.clientX - r.left) * width) / r.width, 0), width),
      y: Math.min(Math.max(((e.clientY - r.top) * height) / r.height, 0), height),
    };
  };

  const add = (a: Omit<Annotation, "id" | "comment">): number => {
    const id = nextId.current++;
    onAdd({ ...a, id, comment: "" } as Annotation);
    onEdit(id);
    return id;
  };

  // Regions and drawings get the element under their middle as context.
  const addWithContext = (a: { kind: "region"; rect: Rect } | { kind: "draw"; points: Point[]; rect: Rect }) => {
    const id = add({ ...a, element: null });
    void pick(a.rect.x + a.rect.width / 2, a.rect.y + a.rect.height / 2).then((element) =>
      onUpdate(id, { element } as Partial<Annotation>),
    );
  };

  const onPointerDown = async (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = toPage(e);
    if (tool === "element") {
      const el = hover && contains(hover, p) ? hover : await pick(p.x, p.y);
      if (el) add({ kind: "element", element: el });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraft({ start: p, points: [p] });
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = toPage(e);
    if (tool === "element") {
      if (e.pointerType === "mouse") hoverAt(p);
      return;
    }
    if (!draft) return;
    setDraft({ ...draft, points: tool === "draw" ? [...draft.points, p] : [draft.start, p] });
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!draft) return;
    const p = toPage(e);
    const points = tool === "draw" ? [...draft.points, p] : [draft.start, p];
    setDraft(null);
    const rect = bounds(points);
    if (tool === "region" && rect.width > 4 && rect.height > 4) addWithContext({ kind: "region", rect });
    if (tool === "draw" && points.length > 2) addWithContext({ kind: "draw", points: simplify(points), rect });
  };

  const stroke = Math.max(width, height) / 600; // about 2px on screen
  const draftRect = draft && tool === "region" ? bounds(draft.points) : null;
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("absolute inset-0 size-full touch-none", tool === "element" ? "cursor-pointer" : "cursor-crosshair")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDraft(null)}
      onPointerLeave={() => setHover(null)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {tool === "element" && hover && (
        <rect
          x={hover.x}
          y={hover.y}
          width={hover.width}
          height={hover.height}
          fill={`${MARK}22`}
          stroke={MARK}
          strokeWidth={stroke}
          strokeDasharray={`${stroke * 3} ${stroke * 2}`}
          pointerEvents="none"
        />
      )}
      {annotations.map((a, i) => (
        <g key={a.id} pointerEvents="none">
          {a.kind === "draw" ? (
            <polyline
              points={a.points.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke={MARK}
              strokeWidth={stroke * 1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : (
            <rect
              {...annotationRect(a)}
              fill={`${MARK}1a`}
              stroke={MARK}
              strokeWidth={a.id === editing ? stroke * 2 : stroke}
              strokeDasharray={a.kind === "region" ? `${stroke * 4} ${stroke * 2}` : undefined}
            />
          )}
          <Badge at={annotationRect(a)} n={i + 1} size={stroke * 9} />
        </g>
      ))}
      {annotations.map((a) => {
        const r = annotationRect(a);
        const size = stroke * 9;
        // A bigger hit target for the badge, to reopen its comment.
        return (
          <circle
            key={a.id}
            cx={Math.max(r.x, size)}
            cy={Math.max(r.y, size)}
            r={size * 1.3}
            fill="transparent"
            className="cursor-pointer"
            onPointerDown={(e) => {
              e.stopPropagation();
              onEdit(a.id);
            }}
          />
        );
      })}
      {draftRect && (
        <rect
          {...draftRect}
          fill={`${MARK}1a`}
          stroke={MARK}
          strokeWidth={stroke}
          strokeDasharray={`${stroke * 4} ${stroke * 2}`}
          pointerEvents="none"
        />
      )}
      {draft && tool === "draw" && (
        <polyline
          points={draft.points.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke={MARK}
          strokeWidth={stroke * 1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      )}
    </svg>
  );
}

function Badge({ at, n, size }: { at: Point; n: number; size: number }) {
  // Kept inside the frame when the mark touches its edge.
  at = { x: Math.max(at.x, size), y: Math.max(at.y, size) };
  return (
    <g>
      <circle cx={at.x} cy={at.y} r={size} fill={MARK} stroke="white" strokeWidth={size / 6} />
      <text
        x={at.x}
        y={at.y}
        fill="white"
        fontSize={size * 1.1}
        fontWeight={700}
        fontFamily="system-ui, sans-serif"
        textAnchor="middle"
        dominantBaseline="central"
      >
        {n}
      </text>
    </g>
  );
}

/** The comment box for one annotation, placed under it. Display coordinates. */
export function AnnotationComment({
  annotation,
  n,
  left,
  top,
  maxWidth,
  onChange,
  onDelete,
  onClose,
}: {
  annotation: Annotation;
  n: number;
  left: number;
  top: number;
  maxWidth: number;
  onChange: (comment: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const width = Math.min(280, maxWidth - 16);
  return (
    <div
      className="absolute z-20 grid gap-1.5 rounded-md border bg-popover p-2 text-xs shadow-xl"
      style={{ left: Math.max(8, Math.min(left, maxWidth - width - 8)), top, width }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[#f43f5e] text-[10px] font-bold text-white">
          {n}
        </span>
        <span className="truncate font-mono">{describeShort(annotation)}</span>
      </div>
      <textarea
        ref={ref}
        value={annotation.comment}
        rows={2}
        placeholder="What should change here?"
        className="resize-none rounded-sm border bg-background px-2 py-1 text-[13px] outline-none focus:border-ring"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)) {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <div className="flex justify-between">
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-destructive" onClick={onDelete}>
          <Trash2Icon />
          Remove
        </Button>
        <Button variant="secondary" size="sm" className="h-6 px-2" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** Tool picker and actions, over the top of the frame while annotating. */
export function AnnotationBar({
  tool,
  count,
  sending,
  onTool,
  onUndo,
  onCancel,
  onSend,
}: {
  tool: AnnotationTool;
  count: number;
  sending: boolean;
  onTool: (t: AnnotationTool) => void;
  onUndo: () => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  return (
    <div className="absolute top-2 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border bg-popover/95 p-1 shadow-xl backdrop-blur">
      {TOOLS.map(({ tool: t, label, icon: Icon }) => (
        <Button
          key={t}
          variant={tool === t ? "secondary" : "ghost"}
          size="icon"
          className="size-7 pointer-coarse:size-9"
          aria-label={label}
          aria-pressed={tool === t}
          title={label}
          onClick={() => onTool(t)}
        >
          <Icon />
        </Button>
      ))}
      <div className="mx-0.5 h-5 w-px bg-border" />
      <Button
        variant="ghost"
        size="icon"
        className="size-7 pointer-coarse:size-9"
        aria-label="Undo"
        title="Undo"
        disabled={count === 0}
        onClick={onUndo}
      >
        <Undo2Icon />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 pointer-coarse:size-9"
        aria-label="Stop annotating"
        title="Stop annotating (Esc)"
        onClick={onCancel}
      >
        <XIcon />
      </Button>
      <Button size="sm" className="ml-0.5 pointer-coarse:h-9" disabled={count === 0 || sending} onClick={onSend}>
        <SendIcon />
        Send{count > 0 ? ` ${count}` : ""}
      </Button>
    </div>
  );
}

// --- output -------------------------------------------------------------------

/**
 * The frame with the marks drawn on it, and a summary for the agent that
 * refers to them by number.
 */
export async function composeAnnotations(
  frame: HTMLCanvasElement,
  page: { width: number; height: number; url: string; title: string },
  annotations: Annotation[],
): Promise<{ file: File; text: string }> {
  const c = document.createElement("canvas");
  c.width = frame.width;
  c.height = frame.height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Couldn't draw the screenshot");
  ctx.drawImage(frame, 0, 0);
  const s = frame.width / page.width;
  ctx.scale(s, s);
  ctx.lineJoin = ctx.lineCap = "round";
  const stroke = 2;
  annotations.forEach((a, i) => {
    ctx.strokeStyle = MARK;
    ctx.fillStyle = `${MARK}1a`;
    ctx.lineWidth = stroke;
    if (a.kind === "draw") {
      ctx.lineWidth = stroke * 1.5;
      ctx.beginPath();
      a.points.forEach((p, j) => (j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    } else {
      const r = annotationRect(a);
      ctx.setLineDash(a.kind === "region" ? [8, 4] : []);
      ctx.fillRect(r.x, r.y, r.width, r.height);
      ctx.strokeRect(r.x, r.y, r.width, r.height);
      ctx.setLineDash([]);
    }
    const r = annotationRect(a);
    const size = 10;
    ctx.beginPath();
    ctx.arc(Math.max(r.x, size), Math.max(r.y, size), size, 0, Math.PI * 2);
    ctx.fillStyle = MARK;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "white";
    ctx.stroke();
    ctx.fillStyle = "white";
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), Math.max(r.x, size), Math.max(r.y, size) + 0.5);
  });
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
  if (!blob) throw new Error("Couldn't encode the screenshot");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = new File([blob], `browser-annotations-${stamp}.png`, { type: "image/png" });

  const lines = [
    `Browser annotations on ${page.url}${page.title ? ` ("${page.title}")` : ""}, viewport ${page.width}×${page.height}. The attached screenshot shows each numbered mark.`,
    "",
  ];
  annotations.forEach((a, i) => {
    lines.push(`${i + 1}. ${describeLong(a)}`);
    if (a.comment.trim()) lines.push(`   Comment: ${a.comment.trim().replace(/\n/g, "\n   ")}`);
  });
  return { file, text: lines.join("\n") };
}

function describeElement(el: BrowserElement): string {
  const parts = [`\`${el.selector}\``, `<${el.tag}>`];
  if (el.name) parts.push(`"${el.name}"`);
  let s = parts.join(" ");
  if (el.component) s += ` in ${el.component}`;
  if (el.source) s += ` (${el.source})`;
  return s;
}

function describeLong(a: Annotation): string {
  const r = annotationRect(a);
  const at = `at (${Math.round(r.x)}, ${Math.round(r.y)}) ${Math.round(r.width)}×${Math.round(r.height)}`;
  if (a.kind === "element") {
    const el = a.element;
    const extra: string[] = [];
    if (el.text && el.text !== el.name) extra.push(`text "${el.text}"`);
    const styles = el.styles ?? {};
    const keep = ["color", "background-color", "font-size", "font-weight", "padding", "margin", "border-radius"]
      .filter((k) => styles[k])
      .map((k) => `${k}: ${styles[k]}`);
    if (keep.length) extra.push(`styles { ${keep.join("; ")} }`);
    return `Element ${describeElement(el)} ${at}${extra.length ? `\n   ${extra.join("; ")}` : ""}`;
  }
  const what = a.kind === "region" ? "Region" : "Drawing";
  return `${what} ${at}${a.element ? `, over ${describeElement(a.element)}` : ""}`;
}

function describeShort(a: Annotation): string {
  if (a.kind !== "element") return a.kind === "region" ? "Region" : "Drawing";
  const el = a.element;
  return el.component ? `${el.component.split(" < ")[0]} · <${el.tag}>` : el.selector;
}

function bounds(points: Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/** Drops points closer than 2px to the last kept one. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= 2) out.push(p);
  }
  return out;
}
