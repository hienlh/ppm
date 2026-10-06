/**
 * The CREATE statement of one SQLite object, for the SQL tab: SQLite keeps the text every object
 * was created with in `sqlite_schema`, so it is read back as it is — for a table together with
 * the indexes created on it. An index SQLite made for a key of its own has no text, and comes
 * back with the key.
 */
import type { Database } from "bun:sqlite";
import type { DbObjectRef } from "../../shared/db-structure.ts";

const TYPES: Partial<Record<DbObjectRef["kind"], string>> = { table: "table", view: "view", trigger: "trigger" };

export function sqliteObjectSql(db: Database, obj: DbObjectRef): string | null {
  const type = TYPES[obj.kind];
  if (!type) return null;
  const row = db.query(`SELECT name, sql FROM sqlite_schema WHERE type = ? AND name = ? COLLATE NOCASE`)
    .get(type, obj.name) as { name: string; sql: string | null } | null;
  if (!row?.sql) return null;
  const out = [`${row.sql};`];
  if (type === "table") {
    const indexes = db.query(`SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`)
      .all(row.name) as { sql: string }[];
    for (const ix of indexes) out.push(`${ix.sql};`);
  }
  return out.join("\n");
}
