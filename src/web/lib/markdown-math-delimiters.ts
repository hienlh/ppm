/**
 * `\[ … \]` and `\( … \)` are how most models write display and inline maths, and
 * `remark-math` understands neither — it knows `$` and `$$` only.
 *
 * The result is worse than an unrendered formula. Markdown reads `\[` as an *escaped
 * bracket*, so a Codex answer came out as a lone `[`, its body as plain prose
 * (`\text{Ngân sách} = \frac{950}{1{,}10}`) and a lone `]`, one line per `<br>`.
 *
 * Rewriting the delimiters to `$$` before parsing is the whole fix. Both forms become `$$`
 * rather than the inline form taking a single `$`: single-dollar text maths is off on
 * purpose, because a sentence pricing two things in dollars would otherwise be swallowed
 * whole between them.
 */

type Range = readonly [start: number, end: number];

/** `$$` is what remark-math reads, as flow when it sits on its own line and inline otherwise. */
const MATH_FENCE = "$$";

const FORMS = [
  /** Display maths, which is written across lines as often as not. */
  { open: "\\[", close: "\\]", allowNewline: true },
  /**
   * Inline maths, and the one that has to be bounded to a single line. A Windows path in
   * prose — `app\(tabs)\_layout.tsx` — opens with the same two characters, and without the
   * bound it would pair with a `\)` somewhere further down the message and eat everything
   * between. Inline maths never spans a line break, so the bound costs nothing.
   */
  { open: "\\(", close: "\\)", allowNewline: false },
] as const;

/** Fenced code blocks, including one still unclosed because the message is mid-stream. */
function fencedRanges(markdown: string): Range[] {
  const ranges: Range[] = [];
  let openChar = "";
  let openLength = 0;
  let openAt = -1;
  let offset = 0;
  for (const line of markdown.split("\n")) {
    const end = offset + line.length;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (openAt >= 0) {
      // A closing fence carries nothing but its own run of markers.
      if (marker && marker[1]![0] === openChar && marker[1]!.length >= openLength && /^ {0,3}[`~]+[ \t]*$/.test(line)) {
        ranges.push([openAt, end]);
        openAt = -1;
      }
    } else if (marker) {
      openChar = marker[1]![0]!;
      openLength = marker[1]!.length;
      openAt = offset;
    }
    offset = end + 1;
  }
  if (openAt >= 0) ranges.push([openAt, markdown.length]);
  return ranges;
}

/** Backtick spans outside the fenced blocks — where a path or a regex is usually written. */
function inlineCodeRanges(markdown: string, fenced: Range[]): Range[] {
  const ranges: Range[] = [];
  let i = 0;
  while (i < markdown.length) {
    const fence = fenced.find(([start, end]) => i >= start && i < end);
    if (fence) { i = fence[1]; continue; }
    if (markdown[i] !== "`") { i++; continue; }
    let run = 0;
    while (markdown[i + run] === "`") run++;
    let j = i + run;
    let closed = -1;
    while (j < markdown.length) {
      if (markdown[j] !== "`") { j++; continue; }
      let candidate = 0;
      while (markdown[j + candidate] === "`") candidate++;
      if (candidate === run) { closed = j + candidate; break; }
      j += candidate;
    }
    // An unmatched run is ordinary text, so only the run itself is stepped over.
    if (closed < 0) { i += run; continue; }
    ranges.push([i, closed]);
    i = closed;
  }
  return ranges;
}

/**
 * Rewrite LaTeX delimiters to the ones `remark-math` reads, leaving code alone.
 *
 * Anything without a closing delimiter is left exactly as it was — which is also what keeps
 * a half-streamed formula from being rewritten into a broken one and back again.
 */
export function normalizeMathDelimiters(markdown: string): string {
  // Free for the overwhelming majority of messages, which contain no maths at all.
  if (!markdown.includes("\\[") && !markdown.includes("\\(")) return markdown;

  const fenced = fencedRanges(markdown);
  const code = [...fenced, ...inlineCodeRanges(markdown, fenced)];
  const inCode = (index: number) => code.some(([start, end]) => index >= start && index < end);

  let out = "";
  let i = 0;
  while (i < markdown.length) {
    const skip = code.find(([start, end]) => i >= start && i < end);
    if (skip) { out += markdown.slice(i, skip[1]); i = skip[1]; continue; }

    const form = FORMS.find((f) => markdown.startsWith(f.open, i));
    // `\\[` is an escaped backslash next to a bracket, not an opening delimiter.
    if (!form || markdown[i - 1] === "\\") { out += markdown[i]; i++; continue; }

    const bodyStart = i + form.open.length;
    const limit = form.allowNewline ? markdown.length : indexOrEnd(markdown, "\n", bodyStart);
    let close = -1;
    for (let j = bodyStart; j <= limit - form.close.length; j++) {
      if (markdown.startsWith(form.close, j) && !inCode(j)) { close = j; break; }
    }
    if (close < 0) { out += markdown[i]; i++; continue; }

    out += MATH_FENCE + markdown.slice(bodyStart, close) + MATH_FENCE;
    i = close + form.close.length;
  }
  return out;
}

function indexOrEnd(text: string, needle: string, from: number): number {
  const found = text.indexOf(needle, from);
  return found < 0 ? text.length : found;
}
