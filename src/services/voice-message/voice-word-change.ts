/**
 * How far one transcript is from another, word by word. Two readers use it: learning (is the
 * user's edit a small correction of misheard words?) and the clean-up's sanity bound (did Haiku
 * tidy the transcript, or write a different one?).
 */

/** Longest text compared; a transcript is two minutes of speech at most. */
export const MAX_COMPARED_CHARS = 4_000;

/** Words, with the punctuation around each one dropped: a comma Haiku added is not a changed word. */
export const words = (text: string): string[] =>
  text.slice(0, MAX_COMPARED_CHARS).split(/\s+/).map((t) => t.replace(/^[\p{P}]+|[\p{P}]+$/gu, "")).filter(Boolean);

function lcsLength(a: readonly string[], b: readonly string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!);
    prev = row;
  }
  return prev[b.length]!;
}

/** Words of `before` that `after` dropped, words `after` added, and how many each side has. */
export function wordDiff(before: string, after: string): { dropped: number; added: number; beforeWords: number; afterWords: number } {
  const a = words(before);
  const b = words(after);
  const common = lcsLength(a, b);
  return { dropped: a.length - common, added: b.length - common, beforeWords: a.length, afterWords: b.length };
}

/** Word-level change between two texts: tokens dropped plus tokens added, and that share of both. */
export function wordChange(before: string, after: string): { changed: number; share: number } {
  const d = wordDiff(before, after);
  const changed = d.dropped + d.added;
  const total = d.beforeWords + d.afterWords;
  return { changed, share: total === 0 ? 0 : changed / total };
}

export const REWRITE_LIMITS = {
  /** Share of the raw transcript's word count the clean-up may add as new words. */
  maxAddedShare: 0.5,
  /**
   * New words always allowed, whatever the share: in a short message every corrected term
   * (`hồ nô` → `Hono`) is a large share of it, and that is exactly the clean-up's job.
   */
  minAddedAllowed: 6,
} as const;

/**
 * Whether a clean-up wrote words the speaker never said rather than tidying theirs. Dropping is
 * what tidying does (fillers, false starts), so only added words count; case is ignored because
 * capitalising is tidying too. A chat message that steers Haiku shows up here as added words.
 */
export function looksRewritten(raw: string, cleaned: string): boolean {
  const d = wordDiff(raw.toLowerCase(), cleaned.toLowerCase());
  return d.added > Math.max(REWRITE_LIMITS.minAddedAllowed, d.beforeWords * REWRITE_LIMITS.maxAddedShare);
}
