/**
 * Learning from the clean-up itself: the words Claude Haiku replaced in Whisper's transcript are
 * counted per project, and a replacement seen in enough separate messages becomes a learned word —
 * which then goes to Whisper as a hint and to the clean-up as a known correction. Nobody has to
 * edit anything, and no extra model call is made: the two texts are compared here, word by word.
 *
 * Two guards keep a wrong fix from teaching itself. A replacement must recur (three messages, or
 * two when the word also appears in the project's own text), and ordinary Vietnamese is learned
 * only as a two-word phrase that goes to the clean-up, never to Whisper.
 */
import type { LearnedSource } from "../../shared/voice-message.ts";
import { termOf } from "./voice-auto-vocabulary.ts";
import { MAX_COMPARED_CHARS } from "./voice-word-change.ts";

export const CLEANUP_LEARN_LIMITS = {
  /** Words on either side of one replacement; more is a rewrite, not a misheard word. */
  maxWords: 4,
  maxToChars: 40,
  maxFromChars: 60,
  /** Messages a replacement must be seen in before it is learned. */
  hitsToLearn: 3,
  /** …or this many when the word is already in the project's own text (a name, a task code). */
  hitsToLearnKnown: 2,
  /** Replacements shown on a card. */
  shownFixes: 6,
} as const;

const VIETNAMESE_LETTER = /[à-ỹÀ-Ỹđ]/u;

interface Token { text: string; key: string }

/** Words with the punctuation around each dropped, and their compare key (lower case, NFC). */
function tokens(text: string): Token[] {
  return text.slice(0, MAX_COMPARED_CHARS).normalize("NFC").split(/\s+/)
    .map((t) => t.replace(/^[\p{P}]+|[\p{P}]+$/gu, ""))
    .filter(Boolean)
    .map((t) => ({ text: t, key: t.toLowerCase() }));
}

type Op = { kind: "same"; a: Token; b: Token } | { kind: "del"; a: Token } | { kind: "ins"; b: Token };

/** A word-level alignment of `a` to `b` (longest common subsequence, then the edits around it). */
function align(a: Token[], b: Token[]): Op[] {
  const n = a.length, m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i]!.key === b[j]!.key ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i]!.key === b[j]!.key) { ops.push({ kind: "same", a: a[i]!, b: b[j]! }); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) ops.push({ kind: "del", a: a[i++]! });
    else ops.push({ kind: "ins", b: b[j++]! });
  }
  while (i < n) ops.push({ kind: "del", a: a[i++]! });
  while (j < m) ops.push({ kind: "ins", b: b[j++]! });
  return ops;
}

export interface Replacement { from: string; to: string; kind: "term" | "phrase" }

/**
 * Whether a replacement's target is a term (goes to Whisper too) or ordinary speech (the clean-up
 * only). A term has no Vietnamese letter and is a strong term on its own (an inner capital, a
 * digit, an acronym), or is one of the project's own words. A capital alone does not make a term:
 * Vietnamese written without marks starts a sentence with one too.
 */
export function replacementKind(to: string, known: ReadonlySet<string>): "term" | "phrase" {
  if (VIETNAMESE_LETTER.test(to)) return "phrase";
  if (known.has(to.toLowerCase())) return "term";
  return to.split(" ").some((w) => termOf(w)?.strong) ? "term" : "phrase";
}

/**
 * The words the clean-up replaced, in order: each run of dropped words directly followed or
 * preceded by a run of added words. Pure insertions and deletions (fillers, punctuation, a word
 * Haiku left out) are not replacements; neither is a change of case alone.
 *
 * A one-word Vietnamese replacement is widened by the word after it (or before it, at the end),
 * so "ta" → "ra" is kept as "ta lệnh" → "ra lệnh": one syllable alone means too many things.
 */
export function replacements(raw: string, cleaned: string, known: ReadonlySet<string> = new Set()): Replacement[] {
  const ops = align(tokens(raw), tokens(cleaned));
  const sameAt = (i: number) => (ops[i]?.kind === "same" ? ops[i] as Extract<Op, { kind: "same" }> : null);
  const out: Replacement[] = [];
  const emit = (dropped: Token[], added: Token[], prev: Extract<Op, { kind: "same" }> | null, next: Extract<Op, { kind: "same" }> | null) => {
    let from = dropped.map((t) => t.text).join(" ");
    let to = added.map((t) => t.text).join(" ");
    let kind = replacementKind(to, known);
    if (kind === "phrase" && dropped.length === 1 && added.length === 1) {
      if (next) { from = `${from} ${next.a.text}`; to = `${to} ${next.b.text}`; }
      else if (prev) { from = `${prev.a.text} ${from}`; to = `${prev.b.text} ${to}`; }
      kind = replacementKind(to, known);
    }
    if (from.toLowerCase() === to.toLowerCase()) return;
    if (dropped.length > CLEANUP_LEARN_LIMITS.maxWords || added.length > CLEANUP_LEARN_LIMITS.maxWords) return;
    if (to.length > CLEANUP_LEARN_LIMITS.maxToChars || from.length > CLEANUP_LEARN_LIMITS.maxFromChars) return;
    if (!/\p{L}/u.test(to)) return;
    out.push({ from, to, kind });
  };
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.kind === "same") { k++; continue; }
    const start = k;
    const dropped: Token[] = [];
    const added: Token[] = [];
    while (k < ops.length && ops[k]!.kind !== "same") {
      const op = ops[k]!;
      if (op.kind === "del") dropped.push(op.a); else if (op.kind === "ins") added.push(op.b);
      k++;
    }
    if (!dropped.length || !added.length) continue;
    const prev = sameAt(start - 1);
    const next = sameAt(k);
    // As many words out as in: word-for-word fixes side by side ("BPM, ta" → "PPM, ra"), each its own.
    if (dropped.length === added.length && dropped.length > 1 && dropped.length <= CLEANUP_LEARN_LIMITS.maxWords) {
      dropped.forEach((d, j) => emit([d], [added[j]!], j === 0 ? prev : null, j === dropped.length - 1 ? next : null));
    } else {
      emit(dropped, added, prev, next);
    }
  }
  return out;
}

/** The replacements as a card shows them ("ta lệnh → ra lệnh", "BPM → PPM"), at most a few. */
export function fixesToShow(raw: string, cleaned: string): Array<{ from: string; to: string }> {
  return replacements(raw, cleaned).slice(0, CLEANUP_LEARN_LIMITS.shownFixes).map(({ from, to }) => ({ from, to }));
}

/**
 * Whether a replacement seen `hits` times is learned: terms already in the project's text sooner,
 * except what the chat's AI read, which is its own guess and always needs the full count.
 */
export function readyToLearn(r: Replacement, hits: number, known: ReadonlySet<string>, source: LearnedSource = "cleanup"): boolean {
  if (source === "chat") return hits >= CLEANUP_LEARN_LIMITS.hitsToLearn;
  if (r.kind === "term" && known.has(r.to.toLowerCase())) return hits >= CLEANUP_LEARN_LIMITS.hitsToLearnKnown;
  return hits >= CLEANUP_LEARN_LIMITS.hitsToLearn;
}
