/**
 * The SELECT and INSERT a Query tab starts from, beside a table's own CREATE on the SQL tab. Both
 * are built from the table's structure with the engine's quoting, so they run as they stand once
 * the INSERT's `?` are filled in.
 */
import type { DbTableStructure } from "../../shared/db-structure.ts";
import type { SqlDialect } from "./dialect.ts";

export function selectScript(dialect: SqlDialect, table: DbTableStructure): string {
  const columns = table.columns.map((c) => dialect.quoteIdent(c.name)).join(", ");
  return `SELECT ${columns || "*"}\nFROM ${dialect.qualify(table.name, table.schema)};`;
}

/** Columns the database fills in itself — an identity or rowid key, a generated column — are left out. */
export function insertScript(dialect: SqlDialect, table: DbTableStructure): string {
  const target = dialect.qualify(table.name, table.schema);
  const columns = table.columns.filter((c) => !c.autoIncrement && !c.generated);
  if (columns.length === 0) return `${dialect.insertDefaultValues(target)};`;
  return `INSERT INTO ${target} (${columns.map((c) => dialect.quoteIdent(c.name)).join(", ")})\nVALUES (${columns.map(() => "?").join(", ")});`;
}
