/**
 * HTML laid over Glide's canvas header, one slot per column. Glide draws everything on a canvas,
 * so DBGate's filter row — a real text box under each column title — cannot be one of its cells:
 * the header is made taller, Glide draws the titles in its top band (`titleBandDrawer`), and this
 * layer puts a slot over each column in step with the grid's horizontal scroll.
 *
 * Positions come from the column widths the grid was given, and the scroll from what
 * `onVisibleRegionChanged` reports — the first column scrolled into view and how far it is pushed
 * left. That report arrives inside the scroll event, while Glide redraws its canvas only when React
 * next renders it, so the scroll is kept as state: moved in the same render as the canvas, the
 * slots and the columns under them reach the screen in the same frame. Moving the slots straight
 * away put them one scroll step ahead of the canvas on every frame of a swipe.
 *
 * Every column has its slot, in view or not, so a box being typed in is never unmounted by a
 * scroll. The layer takes no pointer events itself, only what a slot draws does: the gaps between
 * slots stay the canvas's, where dragging a column's edge resizes it.
 */
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type UIEvent } from "react";

export interface OverlayColumn {
  id: string;
  width: number;
}

/** What `onVisibleRegionChanged` reports: the first column in view and its x translation (0 or less). */
export interface VisibleRegion {
  x: number;
  tx: number;
}

export interface GridHeaderOverlayHandle {
  sync(region: VisibleRegion): void;
}

interface Props {
  columns: readonly OverlayColumn[];
  /** Columns kept at the left edge however far the grid scrolls. */
  freezeColumns: number;
  /** Glide's row marker column, left of the first column; the layer leaves it alone. */
  markerWidth: number;
  height: number;
  /** Room left free at the right edge, where the grid's vertical scrollbar runs past the header. */
  rightInset?: number;
  renderSlot: (column: OverlayColumn, index: number) => ReactNode;
  /** Brings a column into view: one whose slot the browser scrolled a clipping box to show. */
  onRevealColumn?: (index: number) => void;
}

/** Where each column starts, counted from the first column. */
export function columnOffsets(columns: readonly OverlayColumn[]): number[] {
  let x = 0;
  return columns.map((c) => {
    const at = x;
    x += c.width;
    return at;
  });
}

/**
 * How far the scrolling columns are moved left: from the first column in view's start, less the
 * part of it already scrolled past (`tx`), measured from the first column that is not frozen.
 */
export function scrollOffset(offsets: readonly number[], freezeColumns: number, region: VisibleRegion): number {
  const first = Math.max(region.x, freezeColumns);
  if (first >= offsets.length) return 0;
  return offsets[first]! - (offsets[freezeColumns] ?? 0) - region.tx;
}

/**
 * The column under the right edge of the box the scrolling slots are seen through, `width` wide,
 * once they are moved `shift` px left: where a browser that scrolled the box to show something put it.
 */
export function columnAtRightEdge(offsets: readonly number[], freezeColumns: number, shift: number, width: number): number | null {
  const start = offsets[freezeColumns] ?? 0;
  let column: number | null = null;
  for (let i = freezeColumns; i < offsets.length; i++) if (offsets[i]! - start - shift < width) column = i;
  return column;
}

export const GridHeaderOverlay = forwardRef<GridHeaderOverlayHandle, Props>(function GridHeaderOverlay(
  { columns, freezeColumns, markerWidth, height, rightInset = 0, renderSlot, onRevealColumn },
  ref,
) {
  const [region, setRegion] = useState<VisibleRegion>({ x: 0, tx: 0 });
  useImperativeHandle(ref, () => ({ sync: setRegion }), []);
  const clipBox = useRef<HTMLDivElement>(null);

  const offsets = useMemo(() => columnOffsets(columns), [columns]);
  const total = columns.reduce((n, c) => n + c.width, 0);
  const frozenWidth = freezeColumns > 0 ? offsets[freezeColumns] ?? total : 0;

  // A box that clips the slots is still one a browser scrolls to show something in it — a filter
  // box Tab reached off the grid's edge, a ⌄ brought into view — and the slots are placed by the
  // transform alone, so a scrolled box leaves every one of them beside the wrong column for as
  // long as the grid is open. The box goes back at once, and the grid is asked to scroll to the
  // column the browser was showing instead: the one it scrolled under the box's right edge.
  const unscroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const box = e.currentTarget;
    const scrolled = box.scrollLeft;
    if (!scrolled && !box.scrollTop) return;
    box.scrollLeft = 0;
    box.scrollTop = 0;
    // Frozen columns are always in view.
    if (!scrolled || !onRevealColumn || !clipBox.current || !box.contains(clipBox.current)) return;
    const shift = scrollOffset(offsets, freezeColumns, region) + scrolled;
    const column = columnAtRightEdge(offsets, freezeColumns, shift, clipBox.current.clientWidth);
    if (column !== null) onRevealColumn(column);
  }, [onRevealColumn, offsets, freezeColumns, region]);

  // Built apart from the scroll, so a scroll re-renders one transform and not every slot.
  const [frozen, scrolling] = useMemo(() => {
    const slot = (c: OverlayColumn, i: number, left: number) => (
      <div key={c.id} className="pointer-events-none absolute inset-y-0" style={{ left, width: c.width }}>
        {renderSlot(c, i)}
      </div>
    );
    return [
      columns.flatMap((c, i) => (i < freezeColumns ? [slot(c, i, offsets[i]!)] : [])),
      columns.flatMap((c, i) => (i < freezeColumns ? [] : [slot(c, i, offsets[i]! - frozenWidth)])),
    ];
  }, [columns, offsets, freezeColumns, frozenWidth, renderSlot]);

  return (
    <div className="pointer-events-none absolute left-0 top-0 z-10 overflow-hidden" style={{ height, right: rightInset }} onScroll={unscroll}>
      <div ref={clipBox} className="absolute inset-y-0 overflow-hidden" style={{ left: markerWidth + frozenWidth, right: 0 }} onScroll={unscroll}>
        <div
          className="absolute inset-y-0 left-0"
          style={{ width: total - frozenWidth, transform: `translateX(${-scrollOffset(offsets, freezeColumns, region)}px)` }}
        >
          {scrolling}
        </div>
      </div>
      {freezeColumns > 0 && (
        <div className="absolute inset-y-0 overflow-hidden" style={{ left: markerWidth, width: frozenWidth }} onScroll={unscroll}>
          {frozen}
        </div>
      )}
    </div>
  );
});
