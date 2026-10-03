/**
 * How a cell shows a value the canvas cannot draw as it is: NULL as DBGate's faded `(NULL)`, and
 * bytes as their size and first few bytes in hex. The server sends bytes as `{ $binary, size }`
 * with at most a preview of them (`db-values.ts`), which the Cell data view shows in hex or as a picture.
 */
import type { DbBinaryValue } from "../../../../shared/db-grid";

/** DBGate's spelling of NULL in a cell. */
export const NULL_TEXT = "(NULL)";

/** DBGate's spelling of a new row's cell nothing was put in: left out of the INSERT, for the database to fill in. */
export const NO_FIELD_TEXT = "(No Field)";

/** Bytes shown in hex before an ellipsis says there are more. */
const HEX_BYTES = 8;

export function isBinaryValue(value: unknown): value is DbBinaryValue {
  return typeof value === "object" && value !== null && typeof (value as DbBinaryValue).$binary === "string"
    && typeof (value as DbBinaryValue).size === "number";
}

/** `512 bytes`, `12.1 KB`, `3.4 MB`. */
export function formatByteSize(size: number): string {
  if (size < 1024) return `${size} ${size === 1 ? "byte" : "bytes"}`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The first bytes of a base64 text, without decoding the rest of it. */
export function leadingBytes(base64: string, count: number): number[] {
  // Every 4 characters are 3 bytes, so this many characters hold at least `count` bytes.
  const head = base64.slice(0, Math.ceil(count / 3) * 4);
  let raw: string;
  try {
    raw = atob(head);
  } catch {
    return [];
  }
  const out: number[] = [];
  for (let i = 0; i < Math.min(count, raw.length); i++) out.push(raw.charCodeAt(i));
  return out;
}

/** `12.1 KB · 89 50 4E 47 0D 0A 1A 0A…` — empty bytes are just their size. */
export function formatBinary(value: DbBinaryValue): string {
  const size = formatByteSize(value.size);
  if (value.size === 0) return size;
  const hex = leadingBytes(value.$binary, HEX_BYTES).map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
  if (!hex) return size;
  return `${size} · ${hex}${value.size > HEX_BYTES ? "…" : ""}`;
}
