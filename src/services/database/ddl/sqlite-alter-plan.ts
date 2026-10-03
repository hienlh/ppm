/**
 * Planning a SQLite table change against the database itself: in place when SQLite can make it,
 * a rebuild otherwise — and for a rebuild, what it copies rather than writes (`SqliteSchemaText`),
 * read as the schema stands once its own column renames have run. Those run for real inside a
 * savepoint rolled back straight after, so the text is SQLite's own rewrite of every view,
 * trigger, index and check — not PPM's guess at it.
 */
import type { Database } from "bun:sqlite";
import type { TableModel } from "../../../shared/db-table-model.ts";
import { extractChecks, extractGeneratedColumns } from "../analyser-sqlite.ts";
import { sqliteDialect } from "../dialect-sqlite.ts";
import type { DdlPlan } from "./ddl-types.ts";
import { parseSqliteVersion, sqliteAlterInPlace, sqliteRecreateReason } from "./ddl-sqlite.ts";
import { sqliteRebuildRenames, sqliteRecreatePlan, type SqliteSchemaText } from "./sqlite-recreate.ts";
import type { RenameStep, TableDiff } from "./table-diff.ts";

const q = sqliteDialect.quoteIdent;

export function readSqliteSchemaText(db: Database, table: string): SqliteSchemaText {
  const own = db.query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ? COLLATE NOCASE").get(table) as { sql: string | null } | null;
  const createSql = own?.sql ?? "";
  const indexes = new Map<string, string>();
  const indexRows = db.query("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? COLLATE NOCASE AND sql IS NOT NULL").all(table) as { name: string; sql: string }[];
  for (const ix of indexRows) indexes.set(ix.name, ix.sql);
  // In the order they were created, which is the order they fire in.
  const triggerRows = db.query("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? COLLATE NOCASE AND sql IS NOT NULL ORDER BY rowid").all(table) as { sql: string }[];
  const objectNames = new Set((db.query("SELECT name FROM sqlite_schema").all() as { name: string }[]).map((o) => o.name.toLowerCase()));
  const hasSequence = objectNames.has("sqlite_sequence")
    && db.query("SELECT 1 FROM sqlite_sequence WHERE name = ? COLLATE NOCASE").get(table) !== null;
  return {
    createSql,
    checks: extractChecks(createSql),
    generated: extractGeneratedColumns(createSql),
    indexes,
    triggers: triggerRows.map((t) => t.sql),
    objectNames,
    hasSequence,
  };
}

/** The schema text as it reads after `renames`, which are made and undone inside a savepoint. */
export function sqliteSchemaTextAfterRenames(db: Database, table: string, renames: readonly RenameStep[]): SqliteSchemaText {
  if (renames.length === 0) return readSqliteSchemaText(db, table);
  db.exec("SAVEPOINT ppm_rename_probe");
  try {
    for (const step of renames) db.exec(`ALTER TABLE ${q(table)} RENAME COLUMN ${q(step.from)} TO ${q(step.to)}`);
    return readSqliteSchemaText(db, table);
  } finally {
    db.exec("ROLLBACK TO ppm_rename_probe");
    db.exec("RELEASE ppm_rename_probe");
  }
}

export function sqliteAlterPlan(db: Database, base: TableModel, current: TableModel, diff: TableDiff): DdlPlan {
  const version = parseSqliteVersion((db.query("SELECT sqlite_version() AS v").get() as { v: string }).v);
  const reason = sqliteRecreateReason(diff, version);
  if (!reason) return sqliteAlterInPlace(current, diff);
  const foreignKeys = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys === 1;
  const schema = sqliteSchemaTextAfterRenames(db, base.name, sqliteRebuildRenames(base, diff, version));
  return sqliteRecreatePlan(base, current, diff, { version, foreignKeys, schema, reason });
}
