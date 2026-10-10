/**
 * Making characters that do not draw, or that reorder what does, visible in text a person is
 * asked to approve.
 *
 * An approval card shows the SQL, message or command that will run. A right-to-left override
 * (U+202E) placed inside `DROP TABLE x` makes the rest of the line read backwards, a zero-width
 * space splits a word the reader thinks they checked, and a line separator starts a line the
 * reader does not see as one. Each such character is shown as a `⟨U+XXXX⟩` marker instead, so what is displayed
 * is what will run, character for character. Only the display changes; the text sent stays as
 * it was. Tab and line feed are left alone, since a wrapped `<pre>` shows them faithfully.
 */

/**
 * C0/C1 controls except tab and line feed; soft hyphen; combining grapheme joiner; Arabic letter
 * mark; Hangul fillers and Khmer/Mongolian invisible vowels; zero-width and direction marks;
 * line/paragraph separators; bidi embeddings, overrides and isolates; word joiner and invisible
 * operators; deprecated format controls; BOM; interlinear annotation; tag characters.
 */
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/u;

/** One run of ordinary text, or one hidden character to draw as a marker. */
export type RevealedPart = { text: string } | { hidden: string; marker: string };

/** `⟨U+202E⟩` for U+202E. */
export function hiddenCharacterMarker(char: string): string {
  return `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`;
}

/** Whether `text` holds any character this module would reveal. */
export function hasHiddenCharacters(text: string): boolean {
  return HIDDEN.test(text);
}

/**
 * `text` with every hidden character replaced by its marker, for a surface that can only show
 * plain text (a Telegram message, a card body). Nothing else changes and nothing is removed.
 */
export function escapeHiddenCharacters(text: string): string {
  return text.replace(new RegExp(HIDDEN.source, "gu"), hiddenCharacterMarker);
}

/** `text` split into ordinary runs and hidden characters, in order. */
export function revealHiddenCharacters(text: string): RevealedPart[] {
  const parts: RevealedPart[] = [];
  let last = 0;
  for (const match of text.matchAll(new RegExp(HIDDEN.source, "gu"))) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ hidden: match[0], marker: hiddenCharacterMarker(match[0]) });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
