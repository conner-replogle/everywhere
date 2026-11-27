import { Link, useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import { CenteredMessage } from "@/components/centered-message";
import { ConnectionPanel } from "@/components/connection-panel";
import { DeviceContext } from "@/components/device-context";
import { useFleet } from "@/components/fleet";
import { ThreadView, type ThreadTabs } from "@/components/thread-view";
import { Button } from "@/components/ui/button";
import {
  cellRects,
  type GridCell,
  MAX_CELLS,
  MAX_RATIO,
  MIN_RATIO,
  THREAD_DRAG_TYPE,
  threadDrag,
  threadGrid,
  useOpenBeside,
  useThreadDrag,
  useThreadGrid,
} from "@/lib/thread-grid";
import { cn } from "@/lib/utils";

/** Below this width only the focused thread shows (the others stay mounted, hidden). */
const SINGLE_BELOW = 720;

const pct = (f: number) => `${f * 100}%`;

/**
 * The threads open side by side: the one the URL names (focused) and up to
 * three more, as one, two columns, one beside two, or two by two. Cells are
 * only positioned, so a layout change never remounts a thread's panes.
 */
export function ThreadGrid({ deviceId, threadId, tab, split }: { deviceId: string; threadId: string } & ThreadTabs) {
  const grid = useThreadGrid();
  const navigate = useNavigate();
  const openBeside = useOpenBeside();
  const dragged = useThreadDrag();

  // The URL is the focused cell: a thread opened from anywhere lands there,
  // or focuses the cell it's already in. Before paint, so no stale frame shows.
  useLayoutEffect(() => {
    threadGrid.show({ deviceId, threadId, tab, split });
  }, [deviceId, threadId, tab, split]);

  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setNarrow(el.clientWidth > 0 && el.clientWidth < SINGLE_BELOW);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Dividers, as they're dragged (kept once let go).
  const [drag, setDrag] = useState<{ axis: "x" | "y"; ratio: number } | null>(null);
  // The drag as it goes, ahead of a render.
  const live = useRef<{ axis: "x" | "y"; ratio: number } | null>(null);
  const x = drag?.axis === "x" ? drag.ratio : grid.x;
  const y = drag?.axis === "y" ? drag.ratio : grid.y;

  const focusedCell = grid.cells.find((c) => c.id === grid.focus);
  // Until the effect above has caught up with the URL, no cell counts as focused.
  const synced = !!focusedCell && focusedCell.deviceId === deviceId && focusedCell.threadId === threadId;
  const cells = grid.cells;
  const n = cells.length;
  const single = n <= 1 || narrow;
  const rects = cellRects(n, x, y);

  const go = (c: Pick<GridCell, "deviceId" | "threadId" | "tab" | "split">, replace = false) =>
    void navigate({
      to: "/d/$deviceId/t/$threadId",
      params: { deviceId: c.deviceId, threadId: c.threadId },
      search: { ...(c.tab ? { tab: c.tab } : {}), ...(c.split ? { split: c.split } : {}) },
      replace,
      resetScroll: false,
    });
  // The store as it is now: a pointerdown's focus is in before its click's tab.
  const focus = (c: GridCell) => {
    if (c.id === threadGrid.get().focus) return;
    threadGrid.focus(c.id);
    go(c, true);
  };
  const close = (c: GridCell) => {
    threadGrid.close(c.id);
    const g = threadGrid.get();
    const next = g.cells.find((x) => x.id === g.focus);
    if (c.id === grid.focus && next) go(next, true);
  };
  const onlyThis = (c: GridCell) => {
    threadGrid.focus(c.id);
    threadGrid.single();
    if (c.id !== grid.focus) go(c, true);
  };
  const show = (c: GridCell, tabs: ThreadTabs) => {
    if (c.id === threadGrid.get().focus) go({ deviceId: c.deviceId, threadId: c.threadId, ...tabs }, true);
    else threadGrid.setTabs(c.id, tabs.tab, tabs.split);
  };

  const startDrag = (axis: "x" | "y") => (e: React.PointerEvent) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // No such pointer (a synthetic event): the overlay still follows it.
    }
    live.current = { axis, ratio: axis === "x" ? grid.x : grid.y };
    setDrag(live.current);
  };
  const moveDrag = (e: React.PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    const d = live.current;
    if (!d || !box) return;
    const r = d.axis === "x" ? (e.clientX - box.left) / box.width : (e.clientY - box.top) / box.height;
    live.current = { axis: d.axis, ratio: Math.min(MAX_RATIO, Math.max(MIN_RATIO, r)) };
    setDrag(live.current);
  };
  const endDrag = () => {
    const d = live.current;
    if (!d) return;
    live.current = null;
    threadGrid.ratios({ [d.axis]: d.ratio });
    setDrag(null);
  };
  const divider = (axis: "x" | "y", style: React.CSSProperties) => (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round((axis === "x" ? x : y) * 100)}
      aria-valuemin={MIN_RATIO * 100}
      aria-valuemax={MAX_RATIO * 100}
      title="Drag to resize; double-click to even out"
      className={cn(
        "group absolute z-20 flex touch-none items-center justify-center",
        axis === "x" ? "w-3 -translate-x-1/2 cursor-col-resize" : "h-3 -translate-y-1/2 cursor-row-resize",
      )}
      style={style}
      onPointerDown={startDrag(axis)}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => threadGrid.ratios({ [axis]: 0.5 })}
    >
      <div
        className={cn(
          "bg-border transition-colors group-hover:bg-primary/60",
          drag?.axis === axis && "bg-primary/60",
          axis === "x" ? "h-full w-px" : "h-px w-full",
        )}
      />
    </div>
  );

  // A thread dragged in from the sidebar: dropped on a cell it opens there; on
  // the edge strip, beside the others.
  const dropProps = (onDrop: (d: { deviceId: string; threadId: string }) => void) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(THREAD_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDrop: (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData(THREAD_DRAG_TYPE);
      threadDrag.end();
      if (!raw) return;
      e.preventDefault();
      try {
        const d = JSON.parse(raw) as { deviceId?: unknown; threadId?: unknown };
        if (typeof d.deviceId === "string" && typeof d.threadId === "string") onDrop({ deviceId: d.deviceId, threadId: d.threadId });
      } catch {
        // Not one of ours.
      }
    },
  });
  const canAdd = n < MAX_CELLS && !single;
  const canAddSingle = n < MAX_CELLS && !narrow;

  return (
    <div ref={ref} className="relative min-h-0 flex-1">
      {cells.map((c, i) => {
        const shown = single ? c.id === grid.focus : true;
        const r = rects[i]!;
        const focused = synced && c.id === grid.focus;
        const tabs = focused ? { tab, split } : { tab: c.tab, split: c.split };
        return (
          <div
            key={c.id}
            onPointerDownCapture={() => focus(c)}
            onFocusCapture={() => focus(c)}
            className={cn("absolute flex flex-col overflow-hidden", !shown && "invisible")}
            style={
              single
                ? { inset: 0 }
                : { left: pct(r.left), top: pct(r.top), width: pct(r.width), height: pct(r.height) }
            }
          >
            <Cell
              cell={c}
              focused={focused}
              tabs={tabs}
              onShow={(t) => show(c, t)}
              actions={n > 1 ? { onClose: () => close(c), onSingle: () => onlyThis(c) } : undefined}
            />
            {!single && focused && (
              <div className="pointer-events-none absolute inset-0 z-10 ring-1 ring-primary/50 ring-inset" aria-hidden />
            )}
          </div>
        );
      })}
      {!single && n >= 2 && divider("x", { top: 0, bottom: 0, left: pct(x) })}
      {!single && n === 3 && divider("y", { left: pct(x), right: 0, top: pct(y) })}
      {!single && n === 4 && divider("y", { left: 0, right: 0, top: pct(y) })}
      {/* Frames (web pages, dashboards, the desktop) would take the pointer mid-drag. */}
      {drag && <div className={cn("absolute inset-0 z-10", drag.axis === "x" ? "cursor-col-resize" : "cursor-row-resize")} />}
      {dragged && (
        <div className="absolute inset-0 z-30">
          {cells.map((c, i) => {
            if (single && c.id !== grid.focus) return null;
            const r = single ? { left: 0, top: 0, width: canAddSingle ? 0.7 : 1, height: 1 } : rects[i]!;
            const width = canAdd && r.left + r.width >= 0.999 ? r.width * 0.65 : r.width;
            return (
              <DropZone
                key={c.id}
                label="Open here"
                style={{ left: pct(r.left), top: pct(r.top), width: pct(width), height: pct(r.height) }}
                {...dropProps((d) => {
                  threadGrid.focus(c.id);
                  go(d);
                })}
              />
            );
          })}
          {(canAdd || (single && canAddSingle)) && (
            <DropZone
              label="Open beside"
              accent
              style={
                single
                  ? { left: "70%", top: 0, width: "30%", height: "100%" }
                  : { left: pct(x + (1 - x) * 0.65), top: 0, right: 0, height: "100%" }
              }
              {...dropProps((d) => openBeside(d.deviceId, d.threadId))}
            />
          )}
        </div>
      )}
    </div>
  );
}

function DropZone({
  label,
  accent,
  style,
  ...props
}: { label: string; accent?: boolean; style: React.CSSProperties } & Pick<
  React.HTMLAttributes<HTMLDivElement>,
  "onDragOver" | "onDrop"
>) {
  const [over, setOver] = useState(false);
  return (
    <div
      {...props}
      onDragEnter={() => setOver(true)}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        props.onDrop?.(e);
      }}
      className="absolute p-2"
      style={style}
    >
      <div
        className={cn(
          "pointer-events-none flex h-full items-center justify-center rounded-lg border-2 border-dashed text-sm font-medium transition-colors",
          over
            ? "border-primary bg-primary/15 text-foreground"
            : accent
              ? "border-primary/50 bg-background/70 text-muted-foreground"
              : "border-border bg-background/50 text-muted-foreground",
        )}
      >
        {label}
      </div>
    </div>
  );
}

/** One cell: its device's thread, or why it can't be shown. */
function Cell({
  cell,
  focused,
  tabs,
  onShow,
  actions,
}: {
  cell: GridCell;
  focused: boolean;
  tabs: ThreadTabs;
  onShow: (tabs: ThreadTabs) => void;
  actions?: { onClose: () => void; onSingle: () => void };
}) {
  const { devices, entries } = useFleet();
  const entry = entries.get(cell.deviceId);
  if (devices && !devices.some((d) => d.id === cell.deviceId)) {
    return (
      <CenteredMessage title="Device not found" body="It may have been removed from your account.">
        {actions ? (
          <Button variant="outline" size="sm" onClick={actions.onClose}>
            Close
          </Button>
        ) : (
          <Button variant="outline" size="sm" asChild>
            <Link to="/">Back to projects</Link>
          </Button>
        )}
      </CenteredMessage>
    );
  }
  if (!entry) return null;
  return (
    <DeviceContext.Provider value={entry}>
      {entry.conn.state === "connected" ? (
        <ThreadView
          // A thread of its own each time, as a page would be.
          key={`${cell.deviceId}/${cell.threadId}`}
          deviceId={cell.deviceId}
          threadId={cell.threadId}
          tab={tabs.tab}
          split={tabs.split}
          onShow={onShow}
          focused={focused}
          cell={actions}
        />
      ) : (
        <ConnectionPanel />
      )}
    </DeviceContext.Provider>
  );
}
