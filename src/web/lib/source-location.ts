/**
 * The `:120` / `#L120` suffix a tool writes after a path to point at one place in a file.
 *
 * Shared because two callers have to agree on it: a Markdown link's destination
 * (`[label](src/app.ts:120)`) and a command palette query, which is the fallback when that
 * link resolves to nothing. Parsing it in one place is also what keeps the palette's search
 * text and the line it jumps to from disagreeing.
 */
export interface SourceLine {
  start: number;
  /** Inclusive last line of a range; absent for a single line. */
  end?: number;
}

/**
 * `:120`, `:120:5` (column, discarded), `:120-140`, `#L120`, `#L120-L140`.
 * Lazy head so the *last* suffix wins: `C:/src/app.ts:120` keeps the drive letter.
 */
const SOURCE_LOCATION_RE = /^(.*?)(?::(\d+)(?::\d+|-(\d+))?|#L(\d+)(?:-L?(\d+))?)$/;

/**
 * Split a trailing source location off `text`.
 *
 * Returns `null` when a suffix is present but names an impossible line, so a caller can
 * reject the reference outright. Silently dropping it would be worse than useless: it opens
 * line 1 of a file while the text still promises line 0, and nothing on screen says the
 * number was ignored.
 */
export function splitSourceLocation(text: string): { path: string; line?: SourceLine } | null {
  const match = text.match(SOURCE_LOCATION_RE);
  if (!match) return { path: text };
  const start = Number(match[2] ?? match[4]);
  const rawEnd = match[3] ?? match[5];
  if (!Number.isSafeInteger(start) || start < 1) return null;
  if (rawEnd !== undefined) {
    const end = Number(rawEnd);
    if (!Number.isSafeInteger(end) || end < start) return null;
    return { path: match[1]!, line: { start, end } };
  }
  return { path: match[1]!, line: { start } };
}

/** Render a location back into a query string the palette can parse again. */
export function formatSourceLocation(path: string, line?: SourceLine): string {
  if (!line) return path;
  return `${path}:${line.start}${line.end ? `-${line.end}` : ""}`;
}
