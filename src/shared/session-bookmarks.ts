/** A bookmarked turn of a chat (`src/services/session-bookmarks.service.ts`). */
export interface SessionBookmark {
  turnId: string;
  /** The turn's number when it was bookmarked, for the list's order and its label. */
  turnN?: number;
  /** What the list shows: the prompt's first line unless the person named it. */
  label: string;
  createdAt: string;
}

/** Most characters a bookmark's label keeps. */
export const MAX_BOOKMARK_LABEL = 200;

/** A prompt's first non-empty line, as a bookmark's default label. */
export function bookmarkLabelOf(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > MAX_BOOKMARK_LABEL ? line.slice(0, MAX_BOOKMARK_LABEL - 1) + "…" : line;
}
