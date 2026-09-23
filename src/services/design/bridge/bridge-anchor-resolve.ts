import type { CommentQuote } from "../../../shared/design-comment-types.ts";

/**
 * Finding a comment's element again after the file changed.
 *
 * An id is exact only while `gen` is unchanged: once the AI edits text above an element,
 * every later start-tag offset moves and an old id may now name a *different* element. So
 * the id is trusted only when the gen matches and the tag agrees. Otherwise every element
 * of the same tag is scored by its text quote and the best one at or above 0.55 wins; the
 * CSS path only breaks ties. No qualifying candidate means `orphaned` — a detached comment
 * is always preferred to a pin on the wrong element.
 *
 * Shipped into the design frame as source (`ppm.lib.*`), so both functions are
 * self-contained, and the similarity function is passed in rather than referenced. The
 * server runs the same code to re-check a re-anchor the frame reports.
 */

export interface AnchorLike {
  ppmId: number | null;
  gen: string | null;
  tag: string;
  cssPath: string;
  quote: CommentQuote;
}

export interface AnchorCandidate {
  ppmId: number | null;
  tag: string;
  cssPath: string;
  quote: CommentQuote;
}

export type AnchorResolution =
  | { status: "exact" | "reanchored"; index: number; score: number }
  | { status: "orphaned"; index: -1; score: number };

/** Bigram Dice coefficient over lowercased, whitespace-collapsed text, in [0, 1]. */
export function diceSimilarity(a: string, b: string): number {
  const x = a.replace(/\s+/g, " ").trim().toLowerCase();
  const y = b.replace(/\s+/g, " ").trim().toLowerCase();
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = counts.get(g) || 0;
    if (n > 0) {
      shared++;
      counts.set(g, n - 1);
    }
  }
  return (2 * shared) / (x.length - 1 + (y.length - 1));
}

export function resolveAnchor(
  anchor: AnchorLike,
  candidates: readonly AnchorCandidate[],
  currentGen: string | null,
  similarity: (a: string, b: string) => number,
): AnchorResolution {
  const MIN_SCORE = 0.55;
  if (anchor.ppmId !== null && currentGen !== null && anchor.gen === currentGen) {
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      if (c.ppmId === anchor.ppmId && c.tag === anchor.tag) return { status: "exact", index: i, score: 1 };
    }
  }
  const q = anchor.quote;
  // An element with no text of its own (an image, an empty cell) is recognised by its
  // surroundings alone, and only matches another element with no text.
  const textless = q.exact === "";
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.tag !== anchor.tag) continue;
    if (textless && c.quote.exact !== "") continue;
    let score = textless
      ? 0.5 * similarity(q.prefix, c.quote.prefix) + 0.5 * similarity(q.suffix, c.quote.suffix)
      : 0.7 * similarity(q.exact, c.quote.exact) + 0.15 * similarity(q.prefix, c.quote.prefix)
        + 0.15 * similarity(q.suffix, c.quote.suffix);
    if (anchor.cssPath !== "" && c.cssPath === anchor.cssPath) score += 0.05;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best >= 0 && bestScore >= MIN_SCORE
    ? { status: "reanchored", index: best, score: bestScore }
    : { status: "orphaned", index: -1, score: bestScore };
}
