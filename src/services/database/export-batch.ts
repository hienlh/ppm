/**
 * How an export's read hands rows over: in batches, each ending at a number of rows or at about a
 * number of bytes, whichever comes first. Rows alone would not bound anything — a thousand rows of a
 * table that stores files is gigabytes — so a batch of wide rows ends sooner.
 */

export interface BatchLimits {
  /** Rows a batch holds at most. */
  rows: number;
  /** About how many bytes of values a batch holds before it ends. */
  bytes: number;
}

export const EXPORT_BATCH_LIMITS: BatchLimits = { rows: 1_000, bytes: 8 * 1024 * 1024 };

/** Nesting a value is walked into when it is measured; deeper, a value counts as one word. */
const MAX_DEPTH = 32;

/** About how many bytes `value` holds in memory: two a character, one a byte, a word for anything else. */
export function valueBytes(value: unknown, depth = 0): number {
  if (value === null || value === undefined || typeof value === "boolean") return 1;
  if (typeof value === "string") return 2 * value.length;
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof value !== "object" || depth >= MAX_DEPTH) return 8;
  let bytes = 8;
  if (Array.isArray(value)) for (const item of value) bytes += valueBytes(item, depth + 1);
  else for (const [key, item] of Object.entries(value)) bytes += 2 * key.length + valueBytes(item, depth + 1);
  return bytes;
}

export function rowBytes(row: readonly unknown[]): number {
  let bytes = 0;
  for (const value of row) bytes += valueBytes(value);
  return bytes;
}

/** Cuts rows read one at a time into batches within `limits`. */
export class RowBatcher {
  private rows: unknown[][] = [];
  private bytes = 0;

  constructor(private readonly limits: BatchLimits) {}

  /** Adds a row; answers the batch once it is full, and the next one starts empty. */
  add(row: unknown[]): unknown[][] | null {
    this.rows.push(row);
    this.bytes += rowBytes(row);
    return this.rows.length >= this.limits.rows || this.bytes >= this.limits.bytes ? this.take() : null;
  }

  /** The rows added since the last batch — none, when it has just been taken. */
  take(): unknown[][] {
    const rows = this.rows;
    this.rows = [];
    this.bytes = 0;
    return rows;
  }
}

/**
 * How many rows the next `FETCH` asks for, when rows arrive a fetch at a time: about `limits.bytes`
 * of rows as wide as the widest the last fetch read, and never more than twice the last count, so a
 * read starting on narrow rows does not ask for a thousand of the wide ones behind them at once.
 */
export function nextFetchCount(lastCount: number, widestRowBytes: number, limits: BatchLimits): number {
  const byBytes = Math.floor(limits.bytes / Math.max(1, widestRowBytes));
  return Math.max(1, Math.min(limits.rows, 2 * lastCount, byBytes));
}
