/**
 * The line an AI writes first when it read a word of a voice transcript as a different word:
 *
 *   Hiểu là: BPM → PPM; scale → Slack
 *
 * The voice-hints block asks for it (`chat-voice-hints.ts`). PPM reads it twice: the chat draws it
 * as "AI hiểu: BPM → PPM" above the answer instead of as text, and the learning hook counts each
 * pair toward a learned word (`voice-chat-learning.ts`). Shared by server and browser, so nothing
 * here may import from `src/services` or `src/web`.
 *
 * The line is the model's own words, so it is parsed strictly and trusted for nothing on its own:
 * a pair only counts once its heard side is in the transcript, and only after three messages.
 */

/** The fixed words the line starts with; English replies may use the second. */
export const UNDERSTOOD_PREFIXES = ["Hiểu là", "Understood as"] as const;

export interface UnderstoodPair { heard: string; meant: string }

export const UNDERSTOOD_LIMITS = { pairs: 6, chars: 60 } as const;

const ARROW = /\s*(?:→|->|=>)\s*/;
const QUOTES = /^[\s"'`“”‘’*_]+|[\s"'`“”‘’*_.]+$/g;
// The prefix, optionally in bold or italics, with or without the colon inside the emphasis.
const LINE = new RegExp(`^[\\s>*_]*(?:${UNDERSTOOD_PREFIXES.map((p) => p.replace(/\s+/g, "\\s+")).join("|")})\\s*[*_]*\\s*:\\s*[*_]*\\s*(.+)$`, "iu");

const clean = (side: string) => side.replace(QUOTES, "").replace(/\s+/g, " ").trim();

/** The pairs on one line written in the understood form, or null when the line is not one. */
export function parseUnderstoodPairs(line: string): UnderstoodPair[] | null {
  const m = LINE.exec(line.normalize("NFC"));
  if (!m) return null;
  const pairs: UnderstoodPair[] = [];
  for (const piece of m[1]!.split(";")) {
    const sides = piece.split(ARROW);
    if (sides.length !== 2) continue;
    const heard = clean(sides[0]!);
    const meant = clean(sides[1]!);
    if (!heard || !meant || heard.toLowerCase() === meant.toLowerCase()) continue;
    if (Array.from(heard).length > UNDERSTOOD_LIMITS.chars || Array.from(meant).length > UNDERSTOOD_LIMITS.chars) continue;
    if (pairs.some((p) => p.heard.toLowerCase() === heard.toLowerCase())) continue;
    pairs.push({ heard, meant });
    if (pairs.length >= UNDERSTOOD_LIMITS.pairs) break;
  }
  return pairs.length ? pairs : null;
}

/**
 * Splits the understood line off the start of an answer: `pairs` and the answer without it, or
 * null when the answer does not open with one. Blank lines before it are allowed; nothing else.
 */
export function splitUnderstoodLine(text: string): { pairs: UnderstoodPair[]; rest: string } | null {
  const start = text.search(/\S/);
  if (start < 0) return null;
  const end = text.indexOf("\n", start);
  const line = end < 0 ? text.slice(start) : text.slice(start, end);
  const pairs = parseUnderstoodPairs(line);
  if (!pairs) return null;
  return { pairs, rest: end < 0 ? "" : text.slice(end + 1).replace(/^\s*\n/, "") };
}

/** "BPM → PPM; scale → Slack", as the chat shows it after "AI hiểu:". */
export function formatUnderstoodPairs(pairs: readonly UnderstoodPair[]): string {
  return pairs.map((p) => `${p.heard} → ${p.meant}`).join("; ");
}
