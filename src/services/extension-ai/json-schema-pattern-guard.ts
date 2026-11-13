/**
 * Keeps an extension's `pattern` from stalling the server. The pattern comes from the extension
 * and the string it is tested against comes from a model, possibly steered by a web page, and
 * the test runs on PPM's main thread: `^(a+)+$` against 28 a's and a b took 371 ms, one more
 * character doubles it, and a few seconds of stall fail the supervisor's health check, which
 * kills the server and every chat under it. A regex cannot be interrupted once it runs, so the
 * cost is bounded before it starts:
 *
 * - a pattern is at most 256 characters, with no backreferences;
 * - a repeated group may hold no repeat and no alternation (`(a+)+`, `(a|ab)*`), the shapes
 *   that backtrack exponentially;
 * - at most two repeats may be unbounded (`*`, `+`, `{n,}`, or more than 32 times). Each one
 *   can multiply the work by the string's length, so the longest string a pattern is tested
 *   against shrinks with their number: 100,000 characters with none, 5,000 with one, 500 with
 *   two (measured worst cases: `\d*x` on 5,000 digits ~8 ms, `\d*\d*x` on 500 ~14 ms);
 * - one answer spends at most `MAX_PATTERN_WORK` across all its strings, counted as the
 *   length raised to one more than the number of unbounded repeats.
 *
 * The rules refuse some harmless patterns, such as `^[a-z]+(-[a-z]+)*$`; an extension can write
 * those as `^[a-z-]+$` and check the rest itself.
 */

export const MAX_PATTERN_LENGTH = 256;
const MAX_UNBOUNDED_REPEATS = 2;
/** A counted repeat above this behaves like an unbounded one. */
const UNBOUNDED_FROM = 32;
/** The longest string tested, by the number of unbounded repeats in the pattern. */
const MAX_INPUT_BY_REPEATS = [100_000, 5_000, 500] as const;
/** Work one answer may spend on patterns, in the units of `patternWork` (~100-300 ms). */
export const MAX_PATTERN_WORK = 1e9;

interface Group { repeats: boolean; alternates: boolean }

/** How many times a quantifier at `i` lets its atom repeat, and its length; null if none. */
function quantifierAt(pattern: string, i: number): { max: number; length: number } | null {
  const c = pattern[i];
  if (c === "*" || c === "+") return { max: Infinity, length: 1 };
  if (c === "?") return { max: 1, length: 1 };
  if (c !== "{") return null;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
  if (!m) return null;
  const max = m[2] === undefined ? Number(m[1]) : m[3] ? Number(m[3]) : Infinity;
  return { max, length: m[0].length };
}

/** Index just past the escape that starts at `i` (a backslash). */
function skipEscape(pattern: string, i: number): number {
  const next = pattern[i + 1];
  if ((next === "u" || next === "p" || next === "P") && pattern[i + 2] === "{") {
    const close = pattern.indexOf("}", i + 3);
    return close < 0 ? pattern.length : close + 1;
  }
  return i + 2;
}

/** Index just past the character class that starts at `i` (a `[`). */
function skipClass(pattern: string, i: number): number {
  let j = i + 1;
  if (pattern[j] === "^") j++;
  if (pattern[j] === "]") j++;
  while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** Why the pattern is refused (or null), and how many unbounded repeats it has. */
function analyse(pattern: string): { problem: string | null; unbounded: number } {
  const refuse = (problem: string) => ({ problem, unbounded: 0 });
  if (pattern.length > MAX_PATTERN_LENGTH) return refuse(`pattern may be at most ${MAX_PATTERN_LENGTH} characters`);
  const stack: Group[] = [{ repeats: false, alternates: false }];
  let closed: Group | null = null;
  let unbounded = 0;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    const q = quantifierAt(pattern, i);
    if (q) {
      if (q.max > 1) {
        if (closed && (closed.repeats || closed.alternates)) {
          return refuse("pattern may not repeat a group that holds a repeat or an alternation");
        }
        stack[stack.length - 1]!.repeats = true;
        if (q.max > UNBOUNDED_FROM) unbounded++;
      }
      i += q.length + (pattern[i + q.length] === "?" ? 1 : 0);
      closed = null;
      continue;
    }
    closed = null;
    if (c === "\\") {
      if (/[1-9]/.test(pattern[i + 1] ?? "") || (pattern[i + 1] === "k" && pattern[i + 2] === "<")) {
        return refuse("pattern may not use backreferences");
      }
      i = skipEscape(pattern, i);
    } else if (c === "[") {
      i = skipClass(pattern, i);
    } else if (c === "(") {
      stack.push({ repeats: false, alternates: false });
      i++;
    } else if (c === ")") {
      const group = stack.length > 1 ? stack.pop()! : { repeats: false, alternates: false };
      const parent = stack[stack.length - 1]!;
      parent.repeats ||= group.repeats;
      parent.alternates ||= group.alternates;
      closed = group;
      i++;
    } else {
      if (c === "|") stack[stack.length - 1]!.alternates = true;
      i++;
    }
  }
  if (unbounded > MAX_UNBOUNDED_REPEATS) {
    return refuse(`pattern may repeat at most ${MAX_UNBOUNDED_REPEATS} parts without a small bound`);
  }
  return { problem: null, unbounded };
}

/** Why `pattern` could stall the thread that tests it, or null when it cannot. */
export function unsafePatternReason(pattern: string): string | null {
  return analyse(pattern).problem;
}

/** The longest string `pattern` may be tested against. */
export function patternInputLimit(pattern: string): number {
  return MAX_INPUT_BY_REPEATS[Math.min(analyse(pattern).unbounded, MAX_UNBOUNDED_REPEATS)]!;
}

/** The worst-case work of testing a string of `length` against `pattern`. */
export function patternWork(pattern: string, length: number): number {
  return Math.max(1, length) ** (Math.min(analyse(pattern).unbounded, MAX_UNBOUNDED_REPEATS) + 1);
}
