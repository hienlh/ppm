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
 * Every control (`Cc`) except tab and line feed, every format character (`Cf`: soft hyphen,
 * zero-width and direction marks, bidi embeddings/overrides/isolates, word joiner, invisible
 * operators, BOM, interlinear annotation, tag characters, the Arabic, Syriac, Egyptian,
 * musical and shorthand format controls), every default-ignorable code point (combining
 * grapheme joiner, Hangul fillers, Khmer and Mongolian invisibles, and the variation selectors
 * U+FE00–FE0F and U+E0100–E01EF, which draw nothing and can carry a byte apiece inside text
 * that looks ordinary), and the line and paragraph separators.
 *
 * Classes rather than a list of ranges, so a character Unicode adds to them is covered without
 * this pattern being edited. The lookahead keeps tab and line feed out of `Cc`; the `v` flag's
 * set subtraction would say it more directly, but older browsers refuse that flag outright.
 */
const HIDDEN = /(?![\t\n])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u;

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
