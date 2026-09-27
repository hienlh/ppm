/**
 * The `/` trigger of a slash picker, shared by every text box that offers one (the chat
 * composer, the design-instructions editor), so they agree on what opens the picker and
 * what a pick replaces.
 */

/** A `/` opens a query only at the start of the text or after whitespace. */
const QUERY_AT_END_RE = /(?:^|\s)\/(\S*)$/;

/** The query typed after a `/` that ends `textBefore` (the text left of the caret), or null. */
export function slashQueryBefore(textBefore: string): string | null {
  const match = textBefore.match(QUERY_AT_END_RE);
  return match ? (match[1] ?? "") : null;
}

/**
 * `textBefore` with its trailing `/query` replaced by `token` and a space, keeping the
 * whitespace that preceded the `/`. Unchanged when there is no such query.
 */
export function replaceSlashQuery(textBefore: string, token: string): string {
  return textBefore.replace(/(?:^|\s)\/\S*$/, (match) => `${match.startsWith("/") ? "" : match[0]}${token} `);
}

/** `textBefore` with its trailing `/query` removed, keeping the whitespace before it. */
export function stripSlashQuery(textBefore: string): string {
  return textBefore.replace(/(?:^|\s)\/\S*$/, (match) => (match.startsWith("/") ? "" : match[0]!));
}
