/**
 * A deliberately tiny bash lexer for the read-only command check. It accepts only text whose
 * meaning to bash it can state exactly — words, four operators, four exact redirections — and
 * answers null for everything else, so no expansion, substitution, glob or redirection bash
 * would perform can hide behind it. A null means "ask", never "try harder".
 *
 * Accepted:
 *  - Bare word characters `[A-Za-z0-9_./:=@,+%-]`.
 *  - `~` at the start of a word when followed by `/` or the word's end (the home folder), and
 *    `~` inside a word unless right after `=` or `:` — bash expands a tilde there too in a word
 *    that looks like an assignment (`a=~/x`, `p=a:~/x`), even as a command's argument. A plain
 *    mid-word `~` (`HEAD~3`) is literal. `~user`, `~+`, `~-` are refused.
 *  - Single-quoted text (no escapes inside, as in bash) and double-quoted text holding none of
 *    `$`, backtick, `\` or `!`, the characters bash still interprets there.
 *  - Operators `|`, `&&`, `||`, `;` between non-empty segments.
 *  - Redirections `2>/dev/null`, `2>&1`, `>/dev/null`, `&>/dev/null`, as whole tokens.
 * Refused anywhere: control characters (newline included, even quoted), and outside quotes
 * every other character — `$`, backtick, `\`, `&` alone, `( ) { }`, `* ? [ ]`, `#`, `!`, `<`,
 * `>`, `^`, non-ASCII.
 */

export type BashOperator = "|" | "&&" | "||" | ";";

export type BashToken =
  | { kind: "word"; value: string; /** Some part of the word was quoted. */ quoted: boolean }
  | { kind: "op"; value: BashOperator }
  | { kind: "redirect"; value: string };

/** The only redirections accepted; each sends output nowhere or joins stderr to stdout. */
export const ALLOWED_REDIRECTS: readonly string[] = ["2>/dev/null", "2>&1", "&>/dev/null", ">/dev/null"];

const BARE = /^[A-Za-z0-9_./:=@,+%-]$/;
/** Characters bash still expands or interprets inside double quotes. */
const DOUBLE_QUOTE_SPECIAL = /[$`\\!]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

const isBlank = (c: string | undefined) => c === " " || c === "\t";
/** Characters that end a word or a redirection without being part of it. */
const endsToken = (c: string | undefined) => c === undefined || isBlank(c) || c === "|" || c === ";" || c === "&";

/** The tokens of `input`, or null when any part of it lies outside the accepted grammar. */
export function lexBash(input: string): BashToken[] | null {
  if (CONTROL.test(input)) return null;
  const tokens: BashToken[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (isBlank(c)) {
      i++;
      continue;
    }
    const redirect = ALLOWED_REDIRECTS.find((r) => input.startsWith(r, i) && endsToken(input[i + r.length]));
    if (redirect) {
      tokens.push({ kind: "redirect", value: redirect });
      i += redirect.length;
      continue;
    }
    const op = operatorAt(input, i);
    if (op === null) return null;
    if (op) {
      tokens.push({ kind: "op", value: op });
      i += op.length;
      continue;
    }
    const word = readWord(input, i);
    if (!word) return null;
    tokens.push({ kind: "word", value: word.value, quoted: word.quoted });
    i = word.end;
  }
  return segmentsWellFormed(tokens) ? tokens : null;
}

/** The operator starting at `i`; undefined when none starts there, null for one never accepted. */
function operatorAt(input: string, i: number): BashOperator | null | undefined {
  const c = input[i];
  const next = input[i + 1];
  if (c === "|") return next === "|" ? "||" : next === "&" ? null : "|";
  if (c === "&") return next === "&" ? "&&" : null;
  if (c === ";") return next === ";" ? null : ";";
  return undefined;
}

function readWord(input: string, start: number): { value: string; quoted: boolean; end: number } | null {
  let value = "";
  let quoted = false;
  let i = start;
  while (!endsToken(input[i])) {
    const c = input[i]!;
    if (c === "'" || c === '"') {
      const close = input.indexOf(c, i + 1);
      if (close === -1) return null;
      const content = input.slice(i + 1, close);
      if (c === '"' && DOUBLE_QUOTE_SPECIAL.test(content)) return null;
      value += content;
      quoted = true;
      i = close + 1;
      continue;
    }
    if (c === "~") {
      if (!tildeIsLiteralOrHome(input, start, i)) return null;
      value += c;
      i++;
      continue;
    }
    if (!BARE.test(c)) return null;
    value += c;
    i++;
  }
  // `'~'/x` is a relative name to bash, but its value reads like the home folder to every later
  // check, which expands a leading `~`. Only an unquoted leading tilde may survive.
  if (value.startsWith("~") && input[start] !== "~") return null;
  return { value, quoted, end: i };
}

/**
 * Whether a `~` at `i` is one bash leaves alone or expands to the home folder only: at the word's
 * start it must be followed by `/` or end the word; inside a word it must not follow `=` or `:`.
 */
function tildeIsLiteralOrHome(input: string, wordStart: number, i: number): boolean {
  if (i === wordStart) return input[i + 1] === "/" || endsToken(input[i + 1]);
  const prev = input[i - 1];
  return prev !== "=" && prev !== ":";
}

/** Every operator sits between two segments that each hold at least one word. */
function segmentsWellFormed(tokens: readonly BashToken[]): boolean {
  let words = 0;
  for (const t of tokens) {
    if (t.kind === "op") {
      if (words === 0) return false;
      words = 0;
    } else if (t.kind === "word") {
      words++;
    }
  }
  return words > 0;
}
