/**
 * MySQL and MariaDB DDL for the table editor. DDL commits on its own there, so a script cannot be
 * one transaction: the statements run one by one and a failure leaves the ones before it done —
 * which the Save dialog says before OK is pressed.
 *
 * A changed column is restated whole with `CHANGE COLUMN` (MySQL has no way to change one
 * property of a column), so everything the editor does not show — the column's collation, its
 * `ON UPDATE`, whether a generated column is stored — is carried in the model and written again.
 * A column that is only renamed gets `RENAME COLUMN` where the server has it (MySQL 8, MariaDB
 * 10.5.2), which touches nothing else.
 *
 * The order answers MySQL's rule that an AUTO_INCREMENT column must be a key: a column losing
 * AUTO_INCREMENT is changed before its key is dropped, and one gaining it after its key exists.
 */
import type { DbForeignKey } from "../../../shared/db-structure.ts";
import {
  columnName, declaredType, type TableModel, type TableModelColumn, type TableModelForeignKey, type TableModelIndex,
} from "../../../shared/db-table-model.ts";
import { mysqlDialect } from "../dialect-mysql.ts";
import { ConstraintNamer, filled, isPlainWord } from "./ddl-common.ts";
import { DdlUnsupportedError, type DdlPlan, type DdlStatement } from "./ddl-types.ts";
import { orderRenames, type ColumnPair, type TableDiff } from "./table-diff.ts";

export interface MysqlDdlContext {
  mariadb: boolean;
  version: [number, number, number];
  /** Keys other tables hold on this one: a column they point at cannot be dropped under them. */
  references: DbForeignKey[];
}

const q = mysqlDialect.quoteIdent;
const tableSql = (m: Pick<TableModel, "name" | "schema">) => mysqlDialect.qualify(m.name, m.schema);

function atLeast(v: readonly number[], major: number, minor: number, patch: number): boolean {
  const [a = 0, b = 0, c = 0] = v;
  return a !== major ? a > major : b !== minor ? b > minor : c >= patch;
}

/** `RENAME COLUMN` came with MySQL 8.0 and MariaDB 10.5.2. */
export function mysqlHasRenameColumn(ctx: Pick<MysqlDdlContext, "mariadb" | "version">): boolean {
  return ctx.mariadb ? atLeast(ctx.version, 10, 5, 2) : atLeast(ctx.version, 8, 0, 0);
}

/** A column in full, as `CREATE TABLE`, `ADD COLUMN` and `CHANGE COLUMN` write it. */
export function mysqlColumnDefinition(c: TableModelColumn, name = c.name): string {
  const computed = filled(c.computedExpression);
  const parts = [q(name), declaredType(c, "mysql")];
  if (c.collation) parts.push(`COLLATE ${c.collation}`);
  if (computed) {
    parts.push(`GENERATED ALWAYS AS (${computed}) ${c.computedStored ? "STORED" : "VIRTUAL"}`);
    // MariaDB takes no NULL/NOT NULL on a generated column; MySQL takes NOT NULL.
    if (c.notNull) parts.push("NOT NULL");
  } else {
    // Said either way: with explicit_defaults_for_timestamp off, a TIMESTAMP left unsaid is NOT NULL.
    parts.push(c.notNull || c.autoIncrement ? "NOT NULL" : "NULL");
    const def = filled(c.defaultValue);
    if (def && !c.autoIncrement) parts.push(`DEFAULT ${def}`);
    if (c.onUpdate) parts.push(`ON UPDATE ${c.onUpdate}`);
    if (c.autoIncrement) parts.push("AUTO_INCREMENT");
  }
  const comment = filled(c.comment);
  if (comment) parts.push(`COMMENT ${mysqlDialect.literal(comment)}`);
  return parts.join(" ");
}

function keyList(model: TableModel, ids: readonly string[]): string {
  return ids.map((id) => q(columnName(model, id))).join(", ");
}

const INDEX_KINDS: Record<string, string> = { fulltext: "FULLTEXT ", spatial: "SPATIAL " };

function indexSql(model: TableModel, ix: TableModelIndex, name: string): string {
  const parts = ix.columns.map((k) => {
    const target = k.columnId !== null ? `${q(columnName(model, k.columnId))}${k.length ? `(${k.length})` : ""}` : `(${k.expression})`;
    return k.descending ? `${target} DESC` : target;
  });
  const kind = ix.method && INDEX_KINDS[ix.method] ? INDEX_KINDS[ix.method]! : ix.unique ? "UNIQUE " : "";
  const using = ix.method && !INDEX_KINDS[ix.method] && isPlainWord(ix.method) ? ` USING ${ix.method.toUpperCase()}` : "";
  return `CREATE ${kind}INDEX ${q(name)} ON ${tableSql(model)} (${parts.join(", ")})${using}`;
}

function foreignKeyClause(model: TableModel, fk: TableModelForeignKey, name: string): string {
  let sql = `CONSTRAINT ${q(name)} FOREIGN KEY (${keyList(model, fk.columns)}) REFERENCES ${mysqlDialect.qualify(fk.refTable, fk.refSchema ?? model.schema)} (${fk.refColumns.map(q).join(", ")})`;
  if (fk.onUpdate && fk.onUpdate !== "NO ACTION") sql += ` ON UPDATE ${fk.onUpdate}`;
  if (fk.onDelete && fk.onDelete !== "NO ACTION") sql += ` ON DELETE ${fk.onDelete}`;
  return sql;
}

function engineOf(model: TableModel): string | null {
  const engine = filled(model.engine);
  if (engine && !isPlainWord(engine)) throw new DdlUnsupportedError(`${engine} is not an engine name`);
  return engine;
}

/** `CREATE TABLE` with its keys, engine and comment, then its indexes, then its foreign keys. */
export function mysqlCreateTable(model: TableModel): DdlPlan {
  const names = new ConstraintNamer(model, true);
  const body = model.columns.map((c) => `  ${mysqlColumnDefinition(c)}`);
  if (model.primaryKey) body.push(`  PRIMARY KEY (${keyList(model, model.primaryKey.columns)})`);
  for (const u of model.uniques) body.push(`  CONSTRAINT ${q(names.name("UQ", u.name, u.columns))} UNIQUE (${keyList(model, u.columns)})`);
  const engine = engineOf(model);
  const comment = filled(model.comment);
  const options = [engine ? `ENGINE=${engine}` : "", comment ? `COMMENT=${mysqlDialect.literal(comment)}` : ""].filter(Boolean).join(" ");
  const statements: DdlStatement[] = [{ sql: `CREATE TABLE ${tableSql(model)} (\n${body.join(",\n")}\n)${options ? ` ${options}` : ""}` }];
  for (const ix of model.indexes) statements.push({ sql: indexSql(model, ix, names.name("IX", ix.name, ix.columns.map((k) => k.columnId))) });
  for (const fk of model.foreignKeys) statements.push({ sql: `ALTER TABLE ${tableSql(model)} ADD ${foreignKeyClause(model, fk, names.name("FK", fk.name, fk.columns))}` });
  return { statements, recreate: false, warnings: [] };
}

/** `CHANGE COLUMN from to <after>`, after giving NULL rows the default when the column becomes NOT NULL. */
function changeColumn(model: TableModel, pair: ColumnPair, from: string, to: string, out: DdlStatement[]): void {
  const { before, after } = pair;
  const table = tableSql(model);
  const def = filled(after.defaultValue);
  const nowNotNull = after.notNull || after.autoIncrement;
  if (nowNotNull && !before.notNull && def && !after.autoIncrement && !filled(after.computedExpression)) {
    out.push({ sql: `UPDATE ${table} SET ${q(from)} = ${def} WHERE ${q(from)} IS NULL` });
  }
  out.push({ sql: `ALTER TABLE ${table} CHANGE COLUMN ${q(from)} ${mysqlColumnDefinition(after, to)}` });
}

export function mysqlAlterTable(base: TableModel, current: TableModel, diff: TableDiff, ctx: MysqlDdlContext): DdlPlan {
  const table = tableSql(current);
  const statements: DdlStatement[] = [];
  const warnings: string[] = [];
  const changed = new Set<string>();

  // A column losing AUTO_INCREMENT first, while its key still exists: MySQL refuses to drop the
  // key of an AUTO_INCREMENT column.
  for (const pair of diff.alteredColumns) {
    if (pair.before.autoIncrement && !pair.after.autoIncrement) {
      changeColumn(current, pair, pair.before.name, pair.before.name, statements);
      changed.add(pair.after.id);
    }
  }

  const dropped = new Set(diff.droppedColumns.map((c) => c.name));
  for (const fk of ctx.references) {
    const own = fk.table === base.name && (fk.schema ?? null) === (base.schema ?? null);
    if (own || !fk.name || !fk.refColumns.some((c) => dropped.has(c))) continue;
    statements.push({ sql: `ALTER TABLE ${mysqlDialect.qualify(fk.table, fk.schema)} DROP FOREIGN KEY ${q(fk.name)}` });
    warnings.push(`Drops the foreign key ${fk.name} of ${fk.schema ? `${fk.schema}.` : ""}${fk.table}, which points at a column this removes`);
  }

  for (const fk of diff.droppedForeignKeys) if (fk.name) statements.push({ sql: `ALTER TABLE ${table} DROP FOREIGN KEY ${q(fk.name)}` });
  // A unique constraint is an index of the same name in MySQL.
  for (const u of diff.droppedUniques) if (u.name) statements.push({ sql: `DROP INDEX ${q(u.name)} ON ${table}` });
  for (const ix of diff.droppedIndexes) statements.push({ sql: `DROP INDEX ${q(ix.name)} ON ${table}` });
  // A primary key that an AUTO_INCREMENT column keeps needing — `id` gaining a second key column —
  // is swapped in one statement, since dropping it alone would leave that column with no key.
  const basePk = base.primaryKey?.columns ?? [];
  const swapPrimaryKey = !!diff.droppedPrimaryKey && !!diff.addedPrimaryKey
    && current.columns.some((c) => c.autoIncrement && !changed.has(c.id) && basePk.includes(c.id));
  if (diff.droppedPrimaryKey && !swapPrimaryKey) statements.push({ sql: `ALTER TABLE ${table} DROP PRIMARY KEY` });

  for (const c of diff.droppedColumns) statements.push({ sql: `ALTER TABLE ${table} DROP COLUMN ${q(c.name)}` });

  const renamedIds = new Set(diff.renamedColumns.map((r) => r.after.id));
  const staying = current.columns.filter((c) => !renamedIds.has(c.id)).map((c) => c.name);
  const steps = orderRenames(diff.renamedColumns.map((r) => ({ from: r.before.name, to: r.after.name })), staying, true);
  if (mysqlHasRenameColumn(ctx)) {
    for (const step of steps) statements.push({ sql: `ALTER TABLE ${table} RENAME COLUMN ${q(step.from)} TO ${q(step.to)}` });
  } else {
    // Older servers rename with CHANGE COLUMN, which restates the column: the renamed one is then changed already.
    const holder = new Map(diff.renamedColumns.map((r) => [r.before.name, r]));
    for (const step of steps) {
      const pair = holder.get(step.from)!;
      holder.delete(step.from);
      holder.set(step.to, pair);
      changeColumn(current, pair, step.from, step.to, statements);
      changed.add(pair.after.id);
    }
  }

  for (const c of diff.addedColumns) {
    statements.push({ sql: `ALTER TABLE ${table} ADD COLUMN ${mysqlColumnDefinition(c)}` });
    if (c.notNull && !filled(c.defaultValue) && !c.autoIncrement && !filled(c.computedExpression)) {
      warnings.push(`${c.name} is NOT NULL with no default, so the rows ${current.name} already has get the type's zero value`);
    }
  }

  const keeps = [...current.indexes.map((x) => x.name), ...current.uniques.map((x) => x.name ?? ""), ...current.foreignKeys.map((x) => x.name ?? "")].filter(Boolean);
  const names = new ConstraintNamer(current, true, keeps);
  if (diff.addedPrimaryKey) {
    statements.push({ sql: `ALTER TABLE ${table} ${swapPrimaryKey ? "DROP PRIMARY KEY, " : ""}ADD PRIMARY KEY (${keyList(current, diff.addedPrimaryKey.columns)})` });
  }
  for (const u of diff.addedUniques) statements.push({ sql: `ALTER TABLE ${table} ADD CONSTRAINT ${q(names.name("UQ", u.name, u.columns))} UNIQUE (${keyList(current, u.columns)})` });
  for (const ix of diff.addedIndexes) statements.push({ sql: indexSql(current, ix, names.name("IX", ix.name, ix.columns.map((k) => k.columnId))) });

  // Every other change, now that any key an AUTO_INCREMENT needs is in place.
  for (const pair of diff.alteredColumns) if (!changed.has(pair.after.id)) changeColumn(current, pair, pair.after.name, pair.after.name, statements);

  for (const fk of diff.addedForeignKeys) statements.push({ sql: `ALTER TABLE ${table} ADD ${foreignKeyClause(current, fk, names.name("FK", fk.name, fk.columns))}` });

  if (diff.engineChanged) {
    const engine = engineOf(current);
    if (engine) statements.push({ sql: `ALTER TABLE ${table} ENGINE=${engine}` });
  }
  if (diff.commentChanged) statements.push({ sql: `ALTER TABLE ${table} COMMENT=${mysqlDialect.literal(filled(current.comment) ?? "")}` });

  return { statements, recreate: false, warnings };
}
