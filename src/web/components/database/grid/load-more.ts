/**
 * When the grid asks for its next rows, as DBGate does: once the last row read so far scrolls into
 * view. Not while a new row is unsaved — new rows sit under the rows read, and rows read now would
 * land between them, so DBGate stops reading until the new row is saved or reverted.
 */
export type LoadMoreDecision = "load" | "idle" | "blocked-by-new-rows";

export function loadMoreDecision(opts: {
  /** The last row in view, counted from 0 — new rows included. */
  lastVisibleRow: number;
  /** Rows read from the database so far: the new rows come after them. */
  loadedRows: number;
  hasMore: boolean;
  /** Rows are being read already. */
  busy: boolean;
  /** New rows not saved yet. */
  newRows: number;
}): LoadMoreDecision {
  const { lastVisibleRow, loadedRows, hasMore, busy, newRows } = opts;
  if (!hasMore || busy || lastVisibleRow < loadedRows - 1) return "idle";
  return newRows > 0 ? "blocked-by-new-rows" : "load";
}
