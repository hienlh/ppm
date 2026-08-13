export const MAX_RESULT_BYTES = 16 * 1024;
export const EDGE_ROWS = 5;

export interface TruncatedResult {
  head: string | null;
  tail: string | null;
  truncated: boolean;
  bytes: number;
}

const encoder = new TextEncoder();
// Non-fatal decoding: a cut that lands mid-character yields U+FFFD instead of throwing.
const decoder = new TextDecoder();

export function capBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, cut: false };
  return { text: decoder.decode(bytes.slice(0, maxBytes)), cut: true };
}

/**
 * Keep the first and last few rows of a result so an audit entry stays useful
 * without storing the whole payload. Row count is recorded separately, so the
 * dropped middle never distorts how many rows the query actually returned.
 */
export function truncateResult(
  rows: Record<string, unknown>[] | null | undefined,
  maxBytes = MAX_RESULT_BYTES,
  edgeRows = EDGE_ROWS,
): TruncatedResult {
  if (!rows || rows.length === 0) {
    return { head: null, tail: null, truncated: false, bytes: 0 };
  }

  const droppedMiddle = rows.length > edgeRows * 2;
  const headRows = droppedMiddle ? rows.slice(0, edgeRows) : rows;
  const tailRows = droppedMiddle ? rows.slice(-edgeRows) : [];

  // maxBytes is the budget for the whole sample, not per part, so one entry can
  // never store more than the cap regardless of how the rows split.
  const tailBudget = tailRows.length > 0 ? Math.floor(maxBytes / 2) : 0;
  const head = capBytes(safeStringify(headRows), maxBytes - tailBudget);
  const tail = tailRows.length > 0 ? capBytes(safeStringify(tailRows), tailBudget) : null;

  return {
    head: head.text,
    tail: tail?.text ?? null,
    truncated: droppedMiddle || head.cut || (tail?.cut ?? false),
    bytes: encoder.encode(head.text).length + (tail ? encoder.encode(tail.text).length : 0),
  };
}

/** Values coming back from a driver can include BigInt or circular refs, which JSON.stringify rejects. */
function safeStringify(rows: Record<string, unknown>[]): string {
  try {
    return JSON.stringify(rows, (_key, value) => (typeof value === "bigint" ? value.toString() : value)) ?? "";
  } catch {
    // Stay valid JSON — the history viewer parses this column.
    return JSON.stringify([{ _unserializable: `${rows.length} row(s)` }]);
  }
}
