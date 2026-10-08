/**
 * How the status bar's window dock fits its chips into the width it has. Pure, so the
 * squeeze order can be tested without a layout engine.
 *
 * The order, from roomy to cramped:
 *  1. `full`    — every chip with its title.
 *  2. `compact` — only the window in front keeps its title; the others are icons.
 *  3. overflow  — chips are folded into `+N`, newest first, never the one in front.
 *  4. `tight`   — left too little room for a useful slice of its title, the front chip
 *                 drops its title as well.
 * Past `maxChips` the row stops being scannable, so it folds even when it would fit.
 */

export type DockMode = "full" | "compact" | "tight";

export interface DockLayoutInput {
  /** Width the dock can use, in px. */
  available: number;
  /** Each chip's width with its title, in open order. */
  fullWidths: number[];
  /** A chip's width without its title. */
  iconWidth: number;
  /** Gap between chips. */
  gap: number;
  /** Width of the `+N` button. */
  moreWidth: number;
  /** Index of the window in front, or -1 when every window is minimized. */
  frontIndex: number;
  maxChips: number;
  /** Below this many px of title, the front chip shows none at all. */
  minTitle?: number;
}

export interface DockLayout {
  mode: DockMode;
  /** Indexes folded into `+N`. */
  hidden: number[];
}

const sum = (xs: number[], gap: number) => xs.reduce((a, b) => a + b, 0) + Math.max(0, xs.length - 1) * gap;

export function planDock(input: DockLayoutInput): DockLayout {
  const { available, fullWidths, iconWidth, gap, moreWidth, frontIndex, maxChips } = input;
  const minTitle = input.minTitle ?? 56;
  const n = fullWidths.length;
  if (n === 0) return { mode: "full", hidden: [] };

  if (n <= maxChips && sum(fullWidths, gap) <= available) return { mode: "full", hidden: [] };

  const compactWidth = (i: number) => (i === frontIndex ? fullWidths[i]! : iconWidth);
  const compact = fullWidths.map((_, i) => compactWidth(i));
  if (n <= maxChips && sum(compact, gap) <= available) return { mode: "compact", hidden: [] };

  // Fold from the newest end until the rest fits beside `+N`.
  const hidden: number[] = [];
  const visible = () => compact.filter((_, i) => !hidden.includes(i));
  const fits = () => sum(visible(), gap) + gap + moreWidth <= available;
  for (let i = n - 1; i >= 0; i--) {
    if (fits() && n - hidden.length <= maxChips) break;
    if (i === frontIndex) continue;
    hidden.push(i);
  }

  // Whatever is left over goes to the front chip's title; too little of it reads as noise.
  if (frontIndex >= 0 && !hidden.includes(frontIndex)) {
    const others = visible().length - 1;
    const room = available - moreWidth - gap - others * (iconWidth + gap);
    const titleRoom = room - iconWidth;
    if (titleRoom < minTitle) return { mode: "tight", hidden };
  }
  return { mode: "compact", hidden };
}
