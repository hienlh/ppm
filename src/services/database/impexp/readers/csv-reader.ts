/**
 * Import's CSV reader, as RFC 4180 reads it and Postgres's `COPY … CSV` tells NULL from text: an
 * empty field without quotes is NULL, `""` is the empty string — so a file PPM exported comes back
 * with its NULLs. A quote opens a quoted field only at the field's start, and `""` inside one is a
 * quote; line breaks may be LF, CRLF or CR.
 *
 * The delimiter is the one chosen, or Auto-detect's: Excel's `sep=;` first line when there is one,
 * else whichever of `,` `;` Tab `|` the first line holds most often outside quotes. A row with
 * another number of fields than the first is left out, as DBGate leaves it, and said in a
 * warning; a blank line is a row of one NULL in a file of one column, and nothing in any other.
 */
import type { CsvDelimiter, CsvReadOptions } from "../../../../shared/db-impexp.ts";
import { uniqueColumnNames } from "../column-map.ts";
import { fileText } from "./file-text.ts";
import { MAX_RECORD_CHARS, PlaceList, type FileRows, type FileValue } from "./file-rows.ts";

/** What Auto-detect counts, in the order it prefers them on a tie. */
const DETECTED: readonly CsvDelimiter[] = [",", ";", "\t", "|"];

const QUOTE = 34;
const LF = 10;
const CR = 13;

export class CsvReadError extends Error {}

function tooLong(line: number): CsvReadError {
  return new CsvReadError(`Line ${line.toLocaleString("en-US")} starts a row longer than 32 MiB: does a quoted field never end?`);
}

/** The state of a walk through text as the parser reads it, carried from one piece to the next. */
interface Walk {
  at: number;
  quoted: boolean;
  /** A quote inside a quoted field, not yet known to be the first of `""`. */
  quote: boolean;
  fieldStart: boolean;
}

const walkFrom = (at: number): Walk => ({ at, quoted: false, quote: false, fieldStart: true });

/**
 * Walks `text` on from `w.at` as the parser reads it — a quote opens a quoted field only at a
 * field's start, which is after one of `delimiters`, and `""` inside one is a quote — up to the
 * first line break outside quotes, answering where it is, or -1 at the end of the text. Each of
 * `delimiters` met outside quotes is handed to `seen`.
 */
function walkLine(text: string, w: Walk, delimiters: string, seen?: (delimiter: string) => void): number {
  for (; w.at < text.length; w.at++) {
    const c = text.charCodeAt(w.at);
    if (w.quoted) {
      if (!w.quote) {
        if (c === QUOTE) w.quote = true;
        continue;
      }
      w.quote = false;
      if (c === QUOTE) continue;
      w.quoted = false;
    }
    if (c === LF || c === CR) return w.at;
    if (c === QUOTE && w.fieldStart) {
      w.quoted = true;
      w.fieldStart = false;
      continue;
    }
    const ch = text[w.at]!;
    w.fieldStart = delimiters.includes(ch);
    if (w.fieldStart) seen?.(ch);
  }
  return -1;
}

/**
 * The delimiter the first line uses: the one of `,` `;` Tab `|` it holds most often outside
 * quotes, each counted as the parser would read the line with it, the earliest of them on a tie,
 * and a comma when it holds none.
 */
export function detectDelimiter(firstLine: string): CsvDelimiter {
  let best: CsvDelimiter = ",";
  let most = 0;
  for (const d of DETECTED) {
    let n = 0;
    walkLine(firstLine, walkFrom(0), d, () => n++);
    if (n > most) {
      best = d;
      most = n;
    }
  }
  return best;
}

/** Rows a piece of text finished, each with the line it starts on. */
interface CsvBatch {
  rows: FileValue[][];
  lines: number[];
}

const START = 0;
const UNQUOTED = 1;
const QUOTED = 2;
/** A quote inside a quoted field: the next character says whether it closed the field or was the first of `""`. */
const QUOTED_QUOTE = 3;
/** Past a field's closing quote: what follows up to the delimiter is kept, as Excel keeps it. */
const AFTER_QUOTE = 4;

/** Reads records out of text given a piece at a time, carrying a field or a CRLF across two pieces. */
class CsvParser {
  private readonly delimiter: number;
  private state = START;
  private fields: FileValue[] = [];
  private field = "";
  private quoted = false;
  /** A record ended at a CR: an LF next is that same line break. */
  private skipLF = false;
  /** The last character inside quotes was a CR, so an LF next does not start another line. */
  private quotedCR = false;
  private line: number;
  private recordLine: number;
  private recordChars = 0;
  private out: CsvBatch = { rows: [], lines: [] };

  constructor(delimiter: string, firstLine: number) {
    this.delimiter = delimiter.charCodeAt(0);
    this.line = firstLine;
    this.recordLine = firstLine;
  }

  /** The records `text` finished. */
  push(text: string): CsvBatch {
    const n = text.length;
    let seg = 0;
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if (this.skipLF) {
        this.skipLF = false;
        if (c === LF) {
          seg = i + 1;
          continue;
        }
      }
      if (++this.recordChars > MAX_RECORD_CHARS) throw tooLong(this.recordLine);
      if (this.state === QUOTED) {
        if (c === QUOTE) {
          this.field += text.slice(seg, i);
          seg = i + 1;
          this.state = QUOTED_QUOTE;
          this.quotedCR = false;
        } else if (c === LF) {
          if (!this.quotedCR) this.line++;
          this.quotedCR = false;
        } else {
          if (c === CR) this.line++;
          this.quotedCR = c === CR;
        }
        continue;
      }
      if (this.state === QUOTED_QUOTE) {
        if (c === QUOTE) {
          this.field += "\"";
          seg = i + 1;
          this.state = QUOTED;
          continue;
        }
        this.state = AFTER_QUOTE;
      }
      if (c === this.delimiter) {
        this.endField(text.slice(seg, i));
        seg = i + 1;
        this.state = START;
      } else if (c === LF || c === CR) {
        this.endField(text.slice(seg, i));
        this.endRecord();
        seg = i + 1;
        this.skipLF = c === CR;
      } else if (this.state === START) {
        if (c === QUOTE) {
          this.quoted = true;
          this.quotedCR = false;
          seg = i + 1;
          this.state = QUOTED;
        } else {
          this.state = UNQUOTED;
        }
      }
    }
    if (seg < n) this.field += text.slice(seg);
    return this.take();
  }

  /** The last record, when the text did not end with a line break. */
  end(): CsvBatch {
    if (this.state === QUOTED) throw new CsvReadError(`Line ${this.recordLine.toLocaleString("en-US")} opens a quoted field that never ends`);
    if (this.state !== START || this.fields.length > 0) {
      this.endField("");
      this.endRecord();
    }
    return this.take();
  }

  private endField(tail: string): void {
    const text = this.field + tail;
    this.fields.push(this.quoted || text !== "" ? text : null);
    this.field = "";
    this.quoted = false;
    this.state = START;
  }

  private endRecord(): void {
    this.out.rows.push(this.fields);
    this.out.lines.push(this.recordLine);
    this.fields = [];
    this.line++;
    this.recordLine = this.line;
    this.recordChars = 0;
  }

  private take(): CsvBatch {
    const out = this.out;
    this.out = { rows: [], lines: [] };
    return out;
  }
}

/** Skips the line break at `at`, CRLF as one. */
function afterLineBreak(text: string, at: number): number {
  return text.charCodeAt(at) === CR && text.charCodeAt(at + 1) === LF ? at + 2 : at + 1;
}

/** The records of `chunks`, in batches, the delimiter worked out from the first lines first. */
async function* csvBatches(chunks: AsyncGenerator<string>, options: CsvReadOptions): AsyncGenerator<CsvBatch> {
  try {
    // Text up to the line that decides the delimiter: Excel's `sep=` line, or the first that is not blank.
    let text = "";
    let ended = false;
    const more = async (): Promise<boolean> => {
      if (ended) return false;
      const next = await chunks.next();
      if (next.done) {
        ended = true;
        return false;
      }
      text += next.value;
      return true;
    };
    // Before the delimiter is known, a field may start after any of the ones Auto-detect counts.
    const starts = options.delimiter || DETECTED.join("");
    const lineEnd = async (from: number): Promise<number> => {
      const walk = walkFrom(from);
      for (;;) {
        const end = walkLine(text, walk, starts);
        // A CR at the end of the text read so far may be the first half of a CRLF.
        if (end >= 0 && !(text.charCodeAt(end) === CR && end === text.length - 1 && !ended)) return end;
        if (text.length - from > MAX_RECORD_CHARS) throw tooLong(1);
        if (!(await more())) return end >= 0 ? end : text.length;
      }
    };

    let start = 0;
    let firstLine = 1;
    let delimiter: string = options.delimiter;
    let end = await lineEnd(0);
    const sep = /^sep=([^"])$/.exec(text.slice(0, end));
    if (sep) {
      if (!delimiter) delimiter = sep[1]!;
      start = end < text.length ? afterLineBreak(text, end) : end;
      firstLine = 2;
    }
    if (!delimiter) {
      // Auto-detect reads the first line that holds anything.
      let from = start;
      end = from < text.length || !ended ? await lineEnd(from) : from;
      while (end === from && from < text.length) {
        from = afterLineBreak(text, end);
        end = await lineEnd(from);
      }
      delimiter = detectDelimiter(text.slice(from, end));
    }

    const parser = new CsvParser(delimiter, firstLine);
    yield parser.push(text.slice(start));
    text = "";
    for (let next = await chunks.next(); !next.done; next = await chunks.next()) yield parser.push(next.value);
    yield parser.end();
  } finally {
    await chunks.return(undefined);
  }
}

const isBlank = (row: readonly FileValue[]): boolean => row.length === 1 && row[0] === null;

/**
 * Opens a CSV file: reads up to its first row, which names the columns — or, without Has header
 * row, is the first row of data under `col1`, `col2`… A header cell left empty is `col<N>`, and a
 * name met twice is numbered (`id`, `id_1`).
 */
export function openCsv(path: string, options: CsvReadOptions, signal?: AbortSignal): Promise<FileRows> {
  return csvRows(fileText(path, signal), options);
}

/** `openCsv` over text given a piece at a time. */
export async function csvRows(chunks: AsyncGenerator<string>, options: CsvReadOptions): Promise<FileRows> {
  const source = csvBatches(chunks, options);
  let first: FileValue[] | null = null;
  let held: CsvBatch = { rows: [], lines: [] };
  try {
    while (!first) {
      const next = await source.next();
      if (next.done) break;
      const { rows, lines } = next.value;
      const at = rows.findIndex((row) => !isBlank(row));
      if (at < 0) continue;
      first = rows[at]!;
      const from = options.header ? at + 1 : at;
      held = { rows: rows.slice(from), lines: lines.slice(from) };
    }
  } catch (e) {
    await source.return(undefined);
    throw e;
  }

  const width = first?.length ?? 0;
  const columns = !first
    ? []
    : options.header
      ? uniqueColumnNames(first.map((v) => (typeof v === "string" ? v.trim() : "")))
      : first.map((_, i) => `col${i + 1}`);
  const skipped = new PlaceList();
  const keep = (batch: CsvBatch): FileValue[][] => {
    const rows: FileValue[][] = [];
    for (let i = 0; i < batch.rows.length; i++) {
      const row = batch.rows[i]!;
      if (row.length === width) rows.push(row);
      else if (!isBlank(row)) skipped.add(batch.lines[i]!);
    }
    return rows;
  };

  async function* batches(): AsyncGenerator<FileValue[][]> {
    try {
      const firstRows = keep(held);
      held = { rows: [], lines: [] };
      if (firstRows.length) yield firstRows;
      for (let next = await source.next(); !next.done; next = await source.next()) {
        const rows = keep(next.value);
        if (rows.length) yield rows;
      }
    } finally {
      await source.return(undefined);
    }
  }

  return {
    columns,
    batches: batches(),
    warnings: () => skipped.count
      ? [`Skipped ${skipped.count.toLocaleString("en-US")} ${skipped.count === 1 ? "row" : "rows"} without the ${width} fields of the first row: ${skipped.count === 1 ? "line" : "lines"} ${skipped}`]
      : [],
    close: async () => { await source.return(undefined); },
  };
}
