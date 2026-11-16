/**
 * Where a task's quick view (`TaskPeekPopover`) goes on a desktop. It sits beside something it
 * must not cover — the chat's Tasks list, or the task chip it was opened from — and lines up with
 * what was clicked (the list's row, the chip).
 *
 * The sides are tried in the caller's order, three times over:
 *   1. the side has room for the whole peek;
 *   2. some sides have room for a smaller peek (narrower beside, shorter above or below, which
 *      then scrolls inside): the one with the most room for what it needs, so a list at the bottom
 *      of the chat gets the taller space above it rather than the strip over the composer;
 *   3. nothing has room: the side with the most of it, the peek pushed back into the viewport even
 *      where that covers part of what it sits beside.
 * The peek never leaves the viewport, and a peek taller than the viewport scrolls inside.
 */

export type PeekSide = "right" | "left" | "bottom" | "top";

export interface PeekBox { left: number; top: number; width: number; height: number }

export interface PeekPlacementInput {
  /** What the peek must not cover: the list's panel, or the chip. */
  avoid: PeekBox;
  /** What it lines up with: the clicked row (its top) or the chip (its left edge). */
  align: PeekBox;
  /** The peek's natural size. */
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  /** Sides in order of preference. */
  sides: readonly PeekSide[];
  /** Space between the peek and `avoid`. */
  gap?: number;
  /** Space kept free along the viewport's edges. */
  margin?: number;
  /** The smallest a peek may be shrunk to on a side that lacks room for all of it. */
  minWidth?: number;
  minHeight?: number;
}

export interface PeekPlacement {
  side: PeekSide;
  left: number;
  top: number;
  width: number;
  /** The peek scrolls inside past this height. */
  maxHeight: number;
  /** `fit`: whole; `shrink`: smaller but clear of `avoid`; `overlap`: pushed over part of `avoid`. */
  mode: "fit" | "shrink" | "overlap";
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

export function placeTaskPeek(input: PeekPlacementInput): PeekPlacement {
  const { avoid, align, size, viewport, sides } = input;
  const gap = input.gap ?? 8;
  const margin = input.margin ?? 8;
  const minWidth = Math.min(input.minWidth ?? 280, size.width);
  const minHeight = Math.min(input.minHeight ?? 200, size.height);
  const room: Record<PeekSide, number> = {
    right: viewport.width - margin - (avoid.left + avoid.width + gap),
    left: avoid.left - gap - margin,
    bottom: viewport.height - margin - (avoid.top + avoid.height + gap),
    top: avoid.top - gap - margin,
  };
  const across = (s: PeekSide) => s === "left" || s === "right";
  const need = (s: PeekSide) => (across(s) ? size.width : size.height);
  const least = (s: PeekSide) => (across(s) ? minWidth : minHeight);
  const fullHeight = viewport.height - 2 * margin;
  const fullWidth = viewport.width - 2 * margin;

  const at = (side: PeekSide, mode: PeekPlacement["mode"]): PeekPlacement => {
    if (across(side)) {
      const width = Math.min(size.width, mode === "shrink" ? room[side] : fullWidth);
      const maxHeight = Math.min(size.height, fullHeight);
      const top = clamp(align.top, margin, viewport.height - margin - maxHeight);
      const wanted = side === "right" ? avoid.left + avoid.width + gap : avoid.left - gap - width;
      return { side, mode, width, maxHeight, top, left: clamp(wanted, margin, viewport.width - margin - width) };
    }
    const width = Math.min(size.width, fullWidth);
    const maxHeight = Math.min(size.height, mode === "shrink" ? room[side] : fullHeight);
    const left = clamp(align.left, margin, viewport.width - margin - width);
    const wanted = side === "bottom" ? avoid.top + avoid.height + gap : avoid.top - gap - maxHeight;
    return { side, mode, width, maxHeight, left, top: clamp(wanted, margin, viewport.height - margin - maxHeight) };
  };

  const whole = sides.find((s) => room[s] >= need(s));
  if (whole) return at(whole, "fit");
  const share = (s: PeekSide) => room[s] / need(s);
  const roomiest = (from: readonly PeekSide[]) => from.reduce((best, s) => (share(s) > share(best) ? s : best), from[0] ?? "right");
  const smaller = sides.filter((s) => room[s] >= least(s));
  if (smaller.length) return at(roomiest(smaller), "shrink");
  return at(roomiest(sides), "overlap");
}

/** A DOM rect as a `PeekBox`. */
export function peekBox(r: { left: number; top: number; width: number; height: number }): PeekBox {
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}
