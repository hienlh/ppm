/** The row-producing half of a bun:sqlite statement. */
interface RowSource {
  all(): unknown[];
  iterate(): Iterable<unknown>;
}

/**
 * Read a result set, optionally stopping at `maxRows`. A database opened
 * through the filesystem door can be arbitrarily large and is not the user's
 * own project data, so those results are capped rather than pulled into
 * memory in full; the project-scoped door keeps reading everything.
 */
export function readRows(
  stmt: RowSource,
  maxRows?: number,
): { rows: Record<string, unknown>[]; truncated: boolean } {
  if (maxRows === undefined) {
    return { rows: stmt.all() as Record<string, unknown>[], truncated: false };
  }
  const rows: Record<string, unknown>[] = [];
  for (const row of stmt.iterate()) {
    if (rows.length >= maxRows) return { rows, truncated: true };
    rows.push(row as Record<string, unknown>);
  }
  return { rows, truncated: false };
}
