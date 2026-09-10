/**
 * The single table an ad-hoc SELECT reads from, or null when its rows can't be
 * mapped back to one table (JOIN, set operation, subquery, aggregate).
 *
 * Editing a query result writes an UPDATE against this table, so anything
 * ambiguous must return null — the grid then stays read-only instead of
 * collecting edits that have nowhere to go.
 */
export function extractQueryTable(sql: string, defaultSchema: string): { table: string; schema: string } | null {
  const stripped = sql
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");
  if (!/^select\s/i.test(stripped)) return null;
  if (/\b(join|union|intersect|except|group\s+by|distinct)\b/i.test(stripped)) return null;
  // More than one FROM means a subquery or derived table is involved.
  if ((stripped.match(/\bfrom\b/gi) ?? []).length !== 1) return null;
  const m = /\bfrom\s+(?:"([^"]+)"|(\w+))\s*(?:\.\s*(?:"([^"]+)"|(\w+)))?/i.exec(stripped);
  if (!m) return null;
  const first = m[1] ?? m[2]!;
  const second = m[3] ?? m[4];
  return second ? { schema: first, table: second } : { table: first, schema: defaultSchema };
}
