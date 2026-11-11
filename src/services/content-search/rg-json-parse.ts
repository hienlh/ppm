/**
 * Turns ripgrep `--json` output, one line at a time, into `SearchMatch`es.
 * Runs in the search host. rg reports submatch positions as byte offsets into
 * the line's UTF-8; the browser and Monaco count UTF-16 units, so offsets are
 * converted here. A line, path or replacement that is not valid UTF-8 comes as
 * base64 `bytes` and is decoded lossily (invalid bytes become U+FFFD).
 */
import { PREVIEW_AFTER, PREVIEW_BEFORE, type SearchMatch } from "./search-options";

/** rg's `{ text }` or `{ bytes }` (base64) value. */
interface RgData {
  text?: string;
  bytes?: string;
}

interface RgSubmatch {
  start: number;
  end: number;
  replacement?: RgData;
}

const lossy = new TextDecoder("utf-8", { fatal: false });

function dataBytes(d: RgData): Buffer {
  return d.bytes !== undefined ? Buffer.from(d.bytes, "base64") : Buffer.from(d.text ?? "", "utf8");
}

function dataText(d: RgData | undefined): string {
  if (!d) return "";
  return d.text !== undefined ? d.text : lossy.decode(Buffer.from(d.bytes ?? "", "base64"));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * One match on `lineText` (no line terminator) from UTF-16 `column` to `end`,
 * with a preview cut around it so the match stays visible on a long line.
 * Shared with the grep fallback, which finds its columns in JS.
 */
export function buildSearchMatch(
  lineText: string,
  line: number,
  column: number,
  end: number,
  replacement?: string,
): SearchMatch {
  let from = Math.max(0, column - PREVIEW_BEFORE);
  if (from > 0 && isLowSurrogate(lineText.charCodeAt(from))) from++;
  let to = Math.min(lineText.length, end + PREVIEW_AFTER);
  if (to > end && isHighSurrogate(lineText.charCodeAt(to - 1))) to--;

  const match: SearchMatch = {
    line,
    column,
    length: end - column,
    before: lineText.slice(from, column).trimStart(),
    cutBefore: from > 0,
    text: lineText.slice(column, end),
    after: lineText.slice(end, to),
  };
  if (replacement !== undefined) match.replacement = replacement;
  return match;
}

function stripTerminator(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/**
 * One line of `rg --json` output. A `match` event answers its file (relative,
 * without `./`) and one `SearchMatch` per submatch; every other event, or a
 * line that is not JSON, answers null.
 */
export function parseRgJsonLine(raw: string): { file: string; matches: SearchMatch[] } | null {
  // Cheap skip for begin/end/summary; a quote inside a path or line is escaped, so this cannot match there.
  if (!raw.includes('"type":"match"')) return null;
  let event: {
    type?: string;
    data?: { path?: RgData; lines?: RgData; line_number?: number; submatches?: RgSubmatch[] };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }
  const data = event.data;
  if (event.type !== "match" || !data?.lines) return null;

  let file = dataText(data.path);
  if (file.startsWith("./")) file = file.slice(2);
  const line = data.line_number ?? 0;
  const submatches = data.submatches ?? [];

  let lineText: string;
  let toColumn: (byteOffset: number) => number;
  if (data.lines.text !== undefined && Buffer.byteLength(data.lines.text, "utf8") === data.lines.text.length) {
    // ASCII: bytes and UTF-16 units coincide.
    lineText = data.lines.text;
    toColumn = (offset) => offset;
  } else {
    const bytes = dataBytes(data.lines);
    lineText = data.lines.text ?? lossy.decode(bytes);
    toColumn = (offset) => lossy.decode(bytes.subarray(0, offset)).length;
  }
  lineText = stripTerminator(lineText);

  const matches = submatches.map((s) => {
    const column = Math.min(toColumn(s.start), lineText.length);
    const end = Math.min(toColumn(s.end), lineText.length);
    return buildSearchMatch(lineText, line, column, end, s.replacement ? dataText(s.replacement) : undefined);
  });
  return { file, matches };
}
