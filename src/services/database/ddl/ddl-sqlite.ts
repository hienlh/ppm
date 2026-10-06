/**
 * SQLite DDL for the table editor. SQLite's ALTER TABLE does little: add a column, drop one
 * (3.35), rename one (3.25) — and CREATE/DROP INDEX. Any other change rebuilds the table
 * (`sqlite-recreate.ts`), which the Save dialog asks the user to allow first.
 *
 * `sqliteRecreateReason` decides which path a diff takes; everything that stays in place runs in
 * one transaction like Postgres.
 */
import type { DbCheckConstraint } from "../../../shared/db-structure.ts";
import type { TableModel, TableModelColumn, TableModelIndex } from "../../../shared/db-table-model.ts";
import { columnName } from "../../../shared/db-table-model.ts";
import { sqliteDialect } from "../dialect-sqlite.ts";
import { ConstraintNamer, filled } from "./ddl-common.ts";
import type { DdlPlan, DdlStatement } from "./ddl-types.ts";
import { orderRenames, type TableDiff } from "./table-diff.ts";

export type SqliteVersion = [number, number, number];

const q = sqliteDialect.quoteIdent;

export function sqliteAtLeast(v: SqliteVersion, major: number, minor: number, patch: number): boolean {
  const [a, b, c] = v;
  return a !== major ? a > major : b !== minor ? b > minor : c >= patch;
}

/** `sqlite_version()`'s text as numbers. */
export function parseSqliteVersion(text: string): SqliteVersion {
  const [a = 0, b = 0, c = 0] = text.split(".").map((n) => Number.parseInt(n, 10) || 0);
  return [a, b, c];
}

/** What `ALTER TABLE ADD COLUMN` refuses, per SQLite's documentation. */
function addColumnRefusal(c: TableModelColumn): string | null {
  const def = filled(c.defaultValue);
  const computed = filled(c.computedExpression);
  if (c.autoIncrement) return `${c.name} is autoincrement`;
  if (c.notNull && !def && !computed) return `${c.name} is NOT NULL with no default`;
  if (def && (def.startsWith("(") || /^current_(time|date|timestamp)$/i.test(def))) return `${c.name}'s default is not a constant`;
  if (computed && c.computedStored) return `${c.name} is a stored computed column`;
  return null;
}

/**
 * Why this change needs the table rebuilt, in words for the Save dialog; null when SQLite can make
 * it in place. Keys and constraints live inside `CREATE TABLE`, so changing any of them is a
 * rebuild; so is changing a column in any way but its name.
 */
export function sqliteRecreateReason(diff: TableDiff, version: SqliteVersion): string | null {
  if (diff.alteredColumns.length > 0) return `SQLite cannot change the column ${diff.alteredColumns[0]!.after.name} in place`;
  if (diff.droppedPrimaryKey || diff.addedPrimaryKey) return "SQLite cannot change a primary key in place";
  if (diff.droppedUniques.length > 0 || diff.addedUniques.length > 0) return "SQLite cannot change a unique constraint in place";
  if (diff.droppedForeignKeys.length > 0 || diff.addedForeignKeys.length > 0) return "SQLite cannot change a foreign key in place";
  if (diff.renamedColumns.length > 0 && !sqliteAtLeast(version, 3, 25, 0)) return "SQLite before 3.25 cannot rename a column";
  if (diff.droppedColumns.length > 0 && !sqliteAtLeast(version, 3, 35, 0)) return "SQLite before 3.35 cannot drop a column";
  for (const c of diff.addedColumns) {
    const refusal = addColumnRefusal(c);
    if (refusal) return `SQLite cannot add this column in place: ${refusal}`;
  }
  return null;
}

const checkSql = (check: DbCheckConstraint) => `${check.name ? `CONSTRAINT ${q(check.name)} ` : ""}CHECK (${check.expression})`;

/**
 * A column as the rebuilt table's `CREATE TABLE` writes it. `inlineKey` makes it the rowid itself,
 * `INTEGER PRIMARY KEY`, which is the only place AUTOINCREMENT may go — and which is never NULL,
 * so it is not written NOT NULL. `checks` are the column's own, kept on it so that dropping the
 * column later drops them too: SQLite refuses to drop a column a table CHECK names.
 */
export function sqliteColumnDefinition(
  c: TableModelColumn,
  opts: { inlineKey?: boolean; autoincrement?: boolean; computed?: string | null; checks?: readonly DbCheckConstraint[] } = {},
): string {
  const computed = opts.computed === undefined ? filled(c.computedExpression) : opts.computed;
  const type = opts.inlineKey ? "INTEGER" : c.type.trim();
  const parts = [q(c.name)];
  // A column may be declared with no type at all; it then takes any value.
  if (type) parts.push(type);
  if (opts.inlineKey) parts.push(opts.autoincrement ? "PRIMARY KEY AUTOINCREMENT" : "PRIMARY KEY");
  else if (c.notNull) parts.push("NOT NULL");
  const def = filled(c.defaultValue);
  if (def && !computed) parts.push(`DEFAULT ${def}`);
  if (c.collation) parts.push(`COLLATE ${c.collation}`);
  if (computed) parts.push(`GENERATED ALWAYS AS (${computed}) ${c.computedStored ? "STORED" : "VIRTUAL"}`);
  for (const check of opts.checks ?? []) parts.push(checkSql(check));
  return parts.join(" ");
}

/** The checks a column declares itself. */
export function sqliteColumnChecks(checks: readonly DbCheckConstraint[], column: string): DbCheckConstraint[] {
  return checks.filter((check) => check.column !== undefined && check.column.toLowerCase() === column.toLowerCase());
}

export function sqliteKeyList(model: TableModel, ids: readonly string[]): string {
  return ids.map((id) => q(columnName(model, id))).join(", ");
}

export function sqliteIndexSql(model: TableModel, ix: TableModelIndex, name: string): string {
  const parts = ix.columns.map((k) => {
    const target = k.columnId !== null ? q(columnName(model, k.columnId)) : `(${k.expression})`;
    return k.descending ? `${target} DESC` : target;
  });
  const where = filled(ix.where);
  return `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${q(name)} ON ${q(model.name)} (${parts.join(", ")})${where ? ` WHERE ${where}` : ""}`;
}

/** The table body's constraint lines: the key, unique constraints, foreign keys, the table's own checks. */
export function sqliteConstraintLines(model: TableModel, opts: { inlineKeyColumn: string | null; names: ConstraintNamer; checks: TableModel["checks"] }): string[] {
  const lines: string[] = [];
  if (model.primaryKey && !opts.inlineKeyColumn) lines.push(`PRIMARY KEY (${sqliteKeyList(model, model.primaryKey.columns)})`);
  for (const u of model.uniques) {
    const name = filled(u.name);
    lines.push(`${name ? `CONSTRAINT ${q(name)} ` : ""}UNIQUE (${sqliteKeyList(model, u.columns)})`);
  }
  for (const fk of model.foreignKeys) {
    const name = filled(fk.name);
    let line = `${name ? `CONSTRAINT ${q(name)} ` : ""}FOREIGN KEY (${sqliteKeyList(model, fk.columns)}) REFERENCES ${q(fk.refTable)} (${fk.refColumns.map(q).join(", ")})`;
    if (fk.onUpdate && fk.onUpdate !== "NO ACTION") line += ` ON UPDATE ${fk.onUpdate}`;
    if (fk.onDelete && fk.onDelete !== "NO ACTION") line += ` ON DELETE ${fk.onDelete}`;
    lines.push(line);
  }
  for (const check of opts.checks) if (check.column === undefined) lines.push(checkSql(check));
  return lines;
}

/**
 * The column SQLite should make the rowid inline — the whole primary key, autoincrement — and
 * whether it is `AUTOINCREMENT`: kept as the table had it, and given to a column that becomes
 * autoincrement now (DBGate writes `integer primary key autoincrement` for one).
 */
export function sqliteInlineKey(model: TableModel, base: TableModel | null): { column: string | null; autoincrement: boolean } {
  const pk = model.primaryKey;
  if (!pk || pk.columns.length !== 1) return { column: null, autoincrement: false };
  const c = model.columns.find((x) => x.id === pk.columns[0]);
  if (!c?.autoIncrement) return { column: null, autoincrement: false };
  const was = base?.columns.find((x) => x.id === c.id);
  return { column: c.id, autoincrement: c.sqliteAutoincrement || !was || !was.autoIncrement };
}

/** `CREATE TABLE` with every key inside it, SQLite's only place for them, then its indexes. */
export function sqliteCreateTable(model: TableModel): DdlPlan {
  const names = new ConstraintNamer(model, true);
  const inline = sqliteInlineKey(model, null);
  const body = model.columns.map((c) => `  ${sqliteColumnDefinition(c, {
    inlineKey: c.id === inline.column, autoincrement: inline.autoincrement, checks: sqliteColumnChecks(model.checks, c.name),
  })}`);
  for (const line of sqliteConstraintLines(model, { inlineKeyColumn: inline.column, names, checks: model.checks })) body.push(`  ${line}`);
  const options = [model.withoutRowid ? "WITHOUT ROWID" : "", model.strict ? "STRICT" : ""].filter(Boolean).join(", ");
  const statements: DdlStatement[] = [{ sql: `CREATE TABLE ${q(model.name)} (\n${body.join(",\n")}\n)${options ? ` ${options}` : ""}` }];
  for (const ix of model.indexes) statements.push({ sql: sqliteIndexSql(model, ix, names.name("IX", ix.name, ix.columns.map((k) => k.columnId))) });
  return { statements, recreate: false, warnings: [] };
}

/**
 * What SQLite does in place, in one transaction: drop indexes, drop columns — before the renames,
 * which may reuse a dropped column's name — rename, add columns, create indexes.
 */
export function sqliteAlterInPlace(current: TableModel, diff: TableDiff): DdlPlan {
  const table = q(current.name);
  const statements: DdlStatement[] = [];
  for (const ix of diff.droppedIndexes) statements.push({ sql: `DROP INDEX ${q(ix.name)}` });
  for (const c of diff.droppedColumns) statements.push({ sql: `ALTER TABLE ${table} DROP COLUMN ${q(c.name)}` });
  const renamedIds = new Set(diff.renamedColumns.map((r) => r.after.id));
  const staying = current.columns.filter((c) => !renamedIds.has(c.id)).map((c) => c.name);
  for (const step of orderRenames(diff.renamedColumns.map((r) => ({ from: r.before.name, to: r.after.name })), staying, true)) {
    statements.push({ sql: `ALTER TABLE ${table} RENAME COLUMN ${q(step.from)} TO ${q(step.to)}` });
  }
  for (const c of diff.addedColumns) statements.push({ sql: `ALTER TABLE ${table} ADD COLUMN ${sqliteColumnDefinition(c)}` });
  const names = new ConstraintNamer(current, true, current.indexes.map((x) => x.name).filter(Boolean));
  for (const ix of diff.addedIndexes) statements.push({ sql: sqliteIndexSql(current, ix, names.name("IX", ix.name, ix.columns.map((k) => k.columnId))) });
  return { statements, recreate: false, warnings: [] };
}
