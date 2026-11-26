/**
 * A short plain-text preview of Markdown: the first words of a manager's answer or of the user's
 * reply, shown on a folded card so it can be read without opening it. Formatting is taken out
 * (headings, emphasis, links, code fences, lists, tables, HTML tags), every line break becomes a
 * space, and text past `max` characters is cut at a word boundary with "…".
 *
 * Shared by the server (which stores the user's reply this way under the card) and the browser
 * (which previews the manager's stored answer). It never renders anything: the result is drawn as
 * text, so a tag that survives is shown, not run.
 */

/** Characters kept of the user's reply under a card it answered (`CardFollowUp.reply`). */
export const CARD_REPLY_PREVIEW_CHARS = 160;

/** Characters of the manager's answer a folded card previews (two lines at most are drawn). */
export const CARD_ANSWER_PREVIEW_CHARS = 280;

/** How far back from the cut a word boundary is looked for before cutting mid-word. */
const WORD_BOUNDARY_SLACK = 24;

// Line rules take spaces and tabs only, never `\s`: under `m` it also matches line breaks, and two
// `\s*` side by side then split a run of blank lines every possible way (cubic in its length).
const FENCE_LINE = /^[ \t]{0,3}(?:```|~~~).*$/gm;
const HR_LINE = /^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm;
const TABLE_RULE_LINE = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm;
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+/gm;
const QUOTE = /^[ \t]{0,3}(?:>[ \t]?)+/gm;
const LIST_MARK = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]+)\]\([^)]*\)/g;
const REF_LINK = /\[([^\]]+)\]\[[^\]]*\]/g;
const AUTOLINK = /<((?:https?|mailto):[^>\s]+)>/g;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
const INLINE_CODE = /`+([^`\n]+)`+/g;
const STRONG = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g;
const STRIKE = /~~(?=\S)([\s\S]*?\S)~~/g;
/** `*x*` only where a star cannot be arithmetic: `2*3*4` keeps its stars. */
const EM_STAR = /(^|[^\p{L}\p{N}*])\*(?=\S)([^*]*?\S)\*(?![\p{L}\p{N}])/gu;
/** `_x_` only between non-word characters, so `snake_case_name` keeps its underscores. */
const EM_UNDERSCORE = /(^|[^\p{L}\p{N}_])_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}_])/gu;
const ESCAPED = /\\([\\`*_{}[\]()#+\-.!>|~])/g;
const COMBINING = /^\p{M}$/u;
const BOUNDARY = /^[\s\p{P}]$/u;

/** Stands in for text no later rule may touch (an escaped character, inline code) until the end. */
const HELD = /\u0000(\d+)\u0001/g;

/** Markdown as one line of plain text: no markup, no line breaks, whitespace collapsed. */
export function markdownToPlainText(markdown: string): string {
  const held: string[] = [];
  const hold = (s: string): string => `\u0000${held.push(s) - 1}\u0001`;
  let t = markdown.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\u0000\u0001]/g, "");
  // `\*` is a star and `code` is code: neither may be read as emphasis by the rules below.
  t = t.replace(ESCAPED, (_, c: string) => hold(c));
  t = t.replace(FENCE_LINE, "").replace(HR_LINE, "").replace(TABLE_RULE_LINE, "");
  t = t.replace(INLINE_CODE, (_, c: string) => hold(c));
  t = t.replace(HEADING, "").replace(QUOTE, "").replace(LIST_MARK, "");
  t = t.replace(IMAGE, "$1").replace(LINK, "$1").replace(REF_LINK, "$1").replace(AUTOLINK, "$1");
  t = t.replace(HTML_TAG, " ");
  t = t.replace(STRONG, "$2").replace(STRIKE, "$1").replace(EM_STAR, "$1$2").replace(EM_UNDERSCORE, "$1$2");
  // A table row's cells read as a list; a lone pipe (`a | b` in prose) reads the same. Only spaces
  // around it are taken, so each row stays on its own line until the end.
  t = t.replace(/[ \t]*\|[ \t]*/g, " · ").replace(/^ · | · $/gm, "");
  t = t.replace(HELD, (_, i: string) => held[Number(i)] ?? "");
  return t.replace(/\s+/g, " ").trim();
}

/**
 * The first `max` characters of `text`, cut where a word ends when one is near, with "…" added.
 * Counts code points, so neither a surrogate pair nor a letter and the accent after it (a
 * decomposed "ệ") is split. Text that fits comes back unchanged.
 */
export function cutPreview(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  let end = Math.max(1, max - 1);
  while (end > 1 && COMBINING.test(chars[end] ?? "")) end--;
  // A word that ends exactly at the cut is kept; otherwise the cut moves back to the last space.
  if (!BOUNDARY.test(chars[end] ?? "")) {
    const space = chars.lastIndexOf(" ", end);
    if (space > 0 && end - space <= WORD_BOUNDARY_SLACK) end = space;
  }
  return `${chars.slice(0, end).join("").trimEnd().replace(/[\s.,;:!?…·-]+$/u, "")}…`;
}

/**
 * How much of the Markdown a preview of `max` characters reads: plenty for markup and blank lines
 * to be taken out, and a bound on the work whatever the input. Cut only after anything secret was
 * scrubbed from the whole text, which is the caller's order on the server.
 */
const PREVIEW_INPUT_FACTOR = 16;

/** Markdown as a preview line of at most `max` characters; empty when there is no text in it. */
export function markdownPreview(markdown: string | null | undefined, max: number): string {
  if (!markdown) return "";
  let head = markdown.slice(0, max * PREVIEW_INPUT_FACTOR);
  // A cut between the halves of a surrogate pair leaves the first half alone at the end.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return cutPreview(markdownToPlainText(head), max);
}
