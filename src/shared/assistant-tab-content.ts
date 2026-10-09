/**
 * Reading a tab's content for the PPM Assistant's `ui_read_tab`: what the device describes
 * (`describe_tab`), the caps every part is held to, and the line windows text is read in.
 * Shared because the device windows an unsaved editor buffer with the same rules the server
 * applies to the file on disk, so `offset` means the same thing for both.
 */

/** Lines of a file, or of an unsaved buffer, one read returns. */
export const READ_TAB_MAX_LINES = 2000;
/**
 * Bytes of text one read returns. Smaller than a whole large file on purpose: the answer is
 * held under the Assistant's per-call budget (`MAX_TOOL_RESULT_BYTES`), and a window cut
 * there would leave `nextOffset` pointing past text the agent never saw. The rest is read
 * with `offset`.
 */
export const READ_TAB_MAX_BYTES = 40 * 1024;
/** The newest terminal lines one read returns. */
export const READ_TAB_TERMINAL_LINES = 400;
/** Chat messages one read returns. */
export const READ_TAB_CHAT_MESSAGES = 30;
/** Rows of a database tab one read returns. */
export const READ_TAB_DB_ROWS = 200;
/** Characters of one database cell. */
export const READ_TAB_DB_CELL_CHARS = 500;
/** Characters of a Query tab's SQL. */
export const READ_TAB_SQL_CHARS = 20_000;

/** A run of lines out of a text. Lines are 1-based; `nextOffset` is where the next read starts. */
export interface TextWindow {
  text: string;
  fromLine: number;
  toLine: number;
  totalLines: number;
  /** Present when lines after `toLine` were left for another read. */
  nextOffset?: number;
}

const encoder = new TextEncoder();
const bytes = (s: string): number => encoder.encode(s).length;

/** `line` cut to `max` bytes (whole characters only), marking the cut. */
function cutLine(line: string, max: number): string {
  let kept = line.slice(0, max);
  while (kept && bytes(kept) > max) kept = kept.slice(0, Math.floor(kept.length * 0.9));
  return `${kept}… [line cut: ${line.length - kept.length} more characters]`;
}

/**
 * Lines `offset + 1` onward, as many as fit in `maxLines` and `maxBytes`. A single line longer
 * than the whole budget is cut, so a read always makes progress.
 */
export function lineWindow(text: string, offset = 0, maxLines = READ_TAB_MAX_LINES, maxBytes = READ_TAB_MAX_BYTES): TextWindow {
  const lines = text.length ? text.replace(/\r\n/g, "\n").split("\n") : [];
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const start = Math.min(Math.max(0, Math.floor(offset)), total);
  const out: string[] = [];
  let used = 0;
  for (let i = start; i < total && out.length < maxLines; i++) {
    const line = lines[i]!;
    const size = bytes(line) + 1;
    if (used + size > maxBytes) {
      if (out.length === 0) out.push(cutLine(line, maxBytes - 64));
      break;
    }
    out.push(line);
    used += size;
  }
  const end = start + out.length;
  return {
    text: out.join("\n"),
    fromLine: out.length ? start + 1 : start,
    toLine: end,
    totalLines: total,
    ...(end < total ? { nextOffset: end } : {}),
  };
}

/**
 * The newest lines of `lines`, skipping the last `skipFromEnd` (to read further back), at most
 * `maxLines` and `maxBytes`. `nextOffset` is the `skipFromEnd` that reads the lines before these.
 */
export function tailWindow(lines: readonly string[], skipFromEnd = 0, maxLines = READ_TAB_TERMINAL_LINES, maxBytes = READ_TAB_MAX_BYTES): TextWindow {
  const total = lines.length;
  const end = Math.max(0, total - Math.max(0, Math.floor(skipFromEnd)));
  const out: string[] = [];
  let used = 0;
  for (let i = end - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i]!;
    const size = bytes(line) + 1;
    if (used + size > maxBytes) {
      if (out.length === 0) out.unshift(cutLine(line, maxBytes - 64));
      break;
    }
    out.unshift(line);
    used += size;
  }
  const start = end - out.length;
  return {
    text: out.join("\n"),
    fromLine: out.length ? start + 1 : start,
    toLine: end,
    totalLines: total,
    ...(start > 0 ? { nextOffset: total - start } : {}),
  };
}

/** The rows a database tab shows, as the device read them. */
export interface ShownRows {
  columns: string[];
  rows: unknown[][];
  /** Rows exist past these (not loaded yet, or left out by the cap). */
  more: boolean;
}

/**
 * What the device tells the server about one tab (`describe_tab`). Only allow-listed metadata
 * goes in `details`; the parts only the browser holds are added per type, each capped.
 */
export interface TabDescription {
  id: string;
  type: string;
  title: string;
  project: string | null;
  area: "grid" | "dock" | "window";
  details?: Record<string, string | number | boolean>;
  editor?: {
    filePath?: string;
    untitled: boolean;
    /** A diff, a viewer or inline text: not a file the server can read. */
    special: boolean;
    /** Typed and not saved yet. */
    dirty: boolean;
    /** The unsaved text, windowed at the read's `offset`; only when dirty. */
    unsaved?: TextWindow;
  };
  terminal?: { sessionId?: string };
  database?: {
    /** A Query tab's SQL as typed. */
    sql?: string;
    /** What the tab shows; absent when it has not loaded on this device. */
    rows?: ShownRows;
  };
}
