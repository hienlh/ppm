import type { DbBinaryValue } from "../../shared/db-grid.ts";

/**
 * Binary values are sent up to this many bytes. The grid shows a size and a
 * preview; a cell holding a 20 MB file would otherwise ride along with every
 * page that happens to include its row.
 */
export const BINARY_PREVIEW_BYTES = 64 * 1024;

function binaryValue(bytes: Uint8Array): DbBinaryValue {
  const truncated = bytes.length > BINARY_PREVIEW_BYTES;
  const shown = truncated ? bytes.subarray(0, BINARY_PREVIEW_BYTES) : bytes;
  return {
    $binary: Buffer.from(shown.buffer, shown.byteOffset, shown.byteLength).toString("base64"),
    size: bytes.length,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Make one driver value safe to send as JSON without changing what it means:
 *
 * - `bigint` (bun:sqlite with safe integers) stays a number while that is exact
 *   and becomes a string past 2^53, where a JS number would round it.
 * - `NaN` and `±Infinity` (Postgres float) become their names; JSON would turn
 *   them into `null`, which is a different value.
 * - bytes become a `{ $binary }` marker instead of `{"type":"Buffer","data":[…]}`.
 */
export function toJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (value instanceof Uint8Array) return binaryValue(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  return value;
}

export function toJsonRow(row: readonly unknown[]): unknown[] {
  return row.map(toJsonValue);
}
