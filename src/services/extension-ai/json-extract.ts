/**
 * The JSON value inside a model's answer. Models wrap JSON in prose or a code fence, and a
 * Vietnamese answer may cite "[1]" before the object it was asked for, so the first bracket is
 * not necessarily the answer: the whole text is tried first, then each balanced `{…}`/`[…]`
 * span in order (strings and escapes respected), preferring the kind the schema expects.
 */

/** Spans tried before giving up, so a pathological answer cannot cost quadratic time. */
const MAX_CANDIDATES = 200;

export type JsonExtraction = { found: true; value: unknown } | { found: false };

function tryParse(text: string): JsonExtraction {
  try {
    return { found: true, value: JSON.parse(text) };
  } catch {
    return { found: false };
  }
}

/** End index (exclusive) of the balanced span opening at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The first JSON value in `text`. `prefer` ("object" or "array") skips spans of the other
 * kind; when none of the preferred kind parses, the first span of any kind is returned.
 */
export function extractJson(text: string, prefer?: "object" | "array"): JsonExtraction {
  const whole = tryParse(text.trim());
  if (whole.found) return whole;
  let fallback: JsonExtraction = { found: false };
  let tried = 0;
  for (let i = 0; i < text.length && tried < MAX_CANDIDATES; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    tried++;
    const end = balancedEnd(text, i);
    if (end < 0) continue;
    const parsed = tryParse(text.slice(i, end));
    if (!parsed.found) continue;
    const kind = Array.isArray(parsed.value) ? "array" : "object";
    if (!prefer || kind === prefer) return parsed;
    if (!fallback.found) fallback = parsed;
    i = end - 1;
  }
  return fallback;
}
