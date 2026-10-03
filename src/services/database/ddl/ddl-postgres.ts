/**
 * Postgres DDL for the table editor. Every statement runs in one transaction, which Postgres
 * allows for DDL, so a script either happens whole or not at all.
 *
 * A column is changed in place, one `ALTER COLUMN` per property (DBGate's order: rename, type,
 * default, NOT NULL), so what the user did not touch — a comment, a collation, a sequence — is
 * never said again and never lost. Autoincrement is `serial` for a new column and an identity
 * column for one that already exists, which is the only way Postgres can make a column count up
 * without recreating it.
 */
import type { DbForeignKey } from "../../../shared/db-structure.ts";
import {
  columnName, type TableModel, type TableModelColumn, type TableModelForeignKey, type TableModelIndex,
} from "../../../shared/db-table-model.ts";
import { postgresDialect } from "../dialect-postgres.ts";
import { ConstraintNamer, filled, isPlainWord } from "./ddl-common.ts";
import { DdlUnsupportedError, type DdlPlan, type DdlStatement } from "./ddl-types.ts";
import { orderRenames, sameType, type TableDiff } from "./table-diff.ts";

export interface PostgresDdlContext {
  /** `server_version_num`, e.g. 160004. */
  version: number;
  /** Keys other tables hold on this one: a column they point at cannot be dropped under them. */
  references: DbForeignKey[];
}

const q = postgresDialect.quoteIdent;
const tableSql = (m: Pick<TableModel, "name" | "schema">) => postgresDialect.qualify(m.name, m.schema);
const word = (name: string) => (isPlainWord(name) ? name : q(name));

/** serial, bigserial or smallserial: the one of the column's own size. */
export function serialType(type: string): string {
  const t = type.trim().toLowerCase();
  if (/^(bigint|int8|bigserial)\b/.test(t)) return "bigserial";
  if (/^(smallint|int2|smallserial)\b/.test(t)) return "smallserial";
  return "serial";
}

/** A new column, as `CREATE TABLE` and `ADD COLUMN` write it. */
export function postgresColumnDefinition(c: TableModelColumn): string {
  const computed = filled(c.computedExpression);
  const parts = [q(c.name), c.autoIncrement ? serialType(c.type) : c.type.trim()];
  if (c.collation) parts.push(`COLLATE ${c.collation}`);
  // Postgres before 18 has stored generated columns only.
  if (computed) parts.push(`GENERATED ALWAYS AS (${computed}) STORED`);
  if (c.notNull || c.autoIncrement) parts.push("NOT NULL");
  const def = filled(c.defaultValue);
  if (def && !computed && !c.autoIncrement) parts.push(`DEFAULT ${def}`);
  return parts.join(" ");
}

function keyList(model: TableModel, ids: readonly string[]): string {
  return ids.map((id) => q(columnName(model, id))).join(", ");
}

function indexSql(model: TableModel, ix: TableModelIndex, name: string): string {
  const parts = ix.columns.map((k) => [
    k.columnId !== null ? q(columnName(model, k.columnId)) : `(${k.expression})`,
    k.opclass ? word(k.opclass) : "",
    k.descending ? "DESC" : "",
    k.nulls ? `NULLS ${k.nulls.toUpperCase()}` : "",
  ].filter(Boolean).join(" "));
  const method = ix.method ? ` USING ${word(ix.method)}` : "";
  const where = filled(ix.where);
  return `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${q(name)} ON ${tableSql(model)}${method} (${parts.join(", ")})${where ? ` WHERE ${where}` : ""}`;
}

function foreignKeySql(model: TableModel, fk: TableModelForeignKey, name: string): string {
  const ref = postgresDialect.qualify(fk.refTable, fk.refSchema ?? model.schema);
  let sql = `ALTER TABLE ${tableSql(model)} ADD CONSTRAINT ${q(name)} FOREIGN KEY (${keyList(model, fk.columns)}) REFERENCES ${ref} (${fk.refColumns.map(q).join(", ")})`;
  if (fk.onUpdate && fk.onUpdate !== "NO ACTION") sql += ` ON UPDATE ${fk.onUpdate}`;
  if (fk.onDelete && fk.onDelete !== "NO ACTION") sql += ` ON DELETE ${fk.onDelete}`;
  return sql;
}

function commentSql(target: string, comment: string | null): string {
  const c = filled(comment);
  return `COMMENT ON ${target} IS ${c === null ? "NULL" : postgresDialect.literal(c)}`;
}

/** `CREATE TABLE` with its keys, then its indexes, then — last, as DBGate orders them — its foreign keys. */
export function postgresCreateTable(model: TableModel): DdlPlan {
  const names = new ConstraintNamer(model, false);
  const body = model.columns.map((c) => `  ${postgresColumnDefinition(c)}`);
  if (model.primaryKey) body.push(`  CONSTRAINT ${q(names.name("PK", model.primaryKey.name, model.primaryKey.columns))} PRIMARY KEY (${keyList(model, model.primaryKey.columns)})`);
  for (const u of model.uniques) body.push(`  CONSTRAINT ${q(names.name("UQ", u.name, u.columns))} UNIQUE (${keyList(model, u.columns)})`);
  const statements: DdlStatement[] = [{ sql: `CREATE TABLE ${tableSql(model)} (\n${body.join(",\n")}\n)` }];
  if (filled(model.comment)) statements.push({ sql: commentSql(`TABLE ${tableSql(model)}`, model.comment) });
  for (const c of model.columns) if (filled(c.comment)) statements.push({ sql: commentSql(`COLUMN ${tableSql(model)}.${q(c.name)}`, c.comment) });
  for (const ix of model.indexes) statements.push({ sql: indexSql(model, ix, names.name("IX", ix.name, ix.columns.map((k) => k.columnId))) });
  for (const fk of model.foreignKeys) statements.push({ sql: foreignKeySql(model, fk, names.name("FK", fk.name, fk.columns)) });
  return { statements, recreate: false, warnings: [] };
}

/** One column's changes, in place and one property at a time. */
function alterColumn(model: TableModel, before: TableModelColumn, after: TableModelColumn, ctx: PostgresDdlContext, out: DdlStatement[]): void {
  const table = tableSql(model);
  const col = `ALTER TABLE ${table} ALTER COLUMN ${q(after.name)}`;
  const wasComputed = filled(before.computedExpression);
  const isComputed = filled(after.computedExpression);

  if (wasComputed !== isComputed) {
    if (!wasComputed) throw new DdlUnsupportedError(`Postgres cannot make the existing column ${after.name} a computed one; add a new column instead`);
    if (!isComputed) {
      if (ctx.version < 130000) throw new DdlUnsupportedError(`Postgres ${Math.floor(ctx.version / 10000)} cannot turn the computed column ${after.name} into an ordinary one (13 can)`);
      out.push({ sql: `${col} DROP EXPRESSION` });
    } else {
      if (ctx.version < 170000) throw new DdlUnsupportedError(`Postgres ${Math.floor(ctx.version / 10000)} cannot change what ${after.name} is computed from (17 can); add a new column instead`);
      out.push({ sql: `${col} SET EXPRESSION AS (${isComputed})` });
    }
  }

  if (!sameType(before.type, after.type)) {
    // A collation of the column's own would otherwise be reset to the new type's.
    out.push({ sql: `${col} TYPE ${after.type.trim()}${after.collation ? ` COLLATE ${after.collation}` : ""}` });
  }

  const turningOn = !before.autoIncrement && after.autoIncrement;
  const turningOff = before.autoIncrement && !after.autoIncrement;
  const wasDefault = filled(before.defaultValue);
  let nowDefault = filled(after.defaultValue);
  if (turningOff) {
    if (before.identity) out.push({ sql: `${col} DROP IDENTITY` });
    // A serial counts up through its nextval() default, which goes with it unless it was replaced.
    else if (nowDefault === wasDefault) nowDefault = null;
  }
  if (turningOn) {
    if (ctx.version < 100000) throw new DdlUnsupportedError("Postgres 10 is needed to make an existing column autoincrement");
    // An identity column has no default of its own.
    nowDefault = null;
  }
  if (!isComputed && nowDefault !== wasDefault) {
    out.push({ sql: nowDefault === null ? `${col} DROP DEFAULT` : `${col} SET DEFAULT ${nowDefault}` });
  }

  const wasNotNull = before.notNull;
  const nowNotNull = after.notNull || after.autoIncrement;
  if (nowNotNull && !wasNotNull) {
    // DBGate's fillNewNotNullDefaults: rows already NULL would stop SET NOT NULL, so they get the default first.
    if (nowDefault !== null && !turningOn) out.push({ sql: `UPDATE ${table} SET ${q(after.name)} = ${nowDefault} WHERE ${q(after.name)} IS NULL` });
    out.push({ sql: `${col} SET NOT NULL` });
  } else if (!nowNotNull && wasNotNull) {
    out.push({ sql: `${col} DROP NOT NULL` });
  }

  if (turningOn) {
    out.push({ sql: `${col} ADD GENERATED BY DEFAULT AS IDENTITY` });
    // The sequence starts at 1 while the column may already hold 1, 2, 3.
    const seq = `pg_get_serial_sequence(${postgresDialect.literal(table)}, ${postgresDialect.literal(after.name)})`;
    out.push({ sql: `SELECT setval(${seq}, COALESCE((SELECT max(${q(after.name)}) FROM ${table}), 0) + 1, false)` });
  }

  if (filled(before.comment) !== filled(after.comment)) out.push({ sql: commentSql(`COLUMN ${table}.${q(after.name)}`, after.comment) });
}

export function postgresAlterTable(base: TableModel, current: TableModel, diff: TableDiff, ctx: PostgresDdlContext): DdlPlan {
  const table = tableSql(current);
  const statements: DdlStatement[] = [];
  const warnings: string[] = [];

  // Another table's key on a column about to go would stop DROP COLUMN.
  const dropped = new Set(diff.droppedColumns.map((c) => c.name));
  for (const fk of ctx.references) {
    const own = fk.table === base.name && (fk.schema ?? null) === (base.schema ?? null);
    if (own || !fk.name || !fk.refColumns.some((c) => dropped.has(c))) continue;
    statements.push({ sql: `ALTER TABLE ${postgresDialect.qualify(fk.table, fk.schema)} DROP CONSTRAINT ${q(fk.name)}` });
    warnings.push(`Drops the foreign key ${fk.name} of ${fk.schema ? `${fk.schema}.` : ""}${fk.table}, which points at a column this removes`);
  }

  for (const fk of diff.droppedForeignKeys) if (fk.name) statements.push({ sql: `ALTER TABLE ${table} DROP CONSTRAINT ${q(fk.name)}` });
  for (const u of diff.droppedUniques) if (u.name) statements.push({ sql: `ALTER TABLE ${table} DROP CONSTRAINT ${q(u.name)}` });
  for (const ix of diff.droppedIndexes) statements.push({ sql: `DROP INDEX ${postgresDialect.qualify(ix.name, base.schema)}` });
  if (diff.droppedPrimaryKey?.name) statements.push({ sql: `ALTER TABLE ${table} DROP CONSTRAINT ${q(diff.droppedPrimaryKey.name)}` });

  for (const c of diff.droppedColumns) statements.push({ sql: `ALTER TABLE ${table} DROP COLUMN ${q(c.name)}` });

  const renamed = new Set(diff.renamedColumns.map((r) => r.after.id));
  const staying = current.columns.filter((c) => !renamed.has(c.id)).map((c) => c.name);
  for (const step of orderRenames(diff.renamedColumns.map((r) => ({ from: r.before.name, to: r.after.name })), staying)) {
    statements.push({ sql: `ALTER TABLE ${table} RENAME COLUMN ${q(step.from)} TO ${q(step.to)}` });
  }

  for (const { before, after } of diff.alteredColumns) alterColumn(current, before, after, ctx, statements);

  for (const c of diff.addedColumns) {
    const def = filled(c.defaultValue);
    statements.push({ sql: `ALTER TABLE ${table} ADD COLUMN ${postgresColumnDefinition(c)}` });
    if (c.notNull && !def && !c.autoIncrement && !filled(c.computedExpression)) {
      warnings.push(`${c.name} is NOT NULL with no default, so adding it fails if ${current.name} has rows`);
    }
  }
  if (filled(base.comment) !== filled(current.comment)) statements.push({ sql: commentSql(`TABLE ${table}`, current.comment) });

  // Names the table keeps are taken; one being dropped is free again.
  const keeps = [
    ...current.indexes.map((x) => x.name), ...current.uniques.map((x) => x.name ?? ""), ...current.foreignKeys.map((x) => x.name ?? ""),
    current.primaryKey?.name ?? "",
  ].filter(Boolean);
  const names = new ConstraintNamer(current, false, keeps);
  if (diff.addedPrimaryKey) {
    statements.push({ sql: `ALTER TABLE ${table} ADD CONSTRAINT ${q(names.name("PK", diff.addedPrimaryKey.name, diff.addedPrimaryKey.columns))} PRIMARY KEY (${keyList(current, diff.addedPrimaryKey.columns)})` });
  }
  for (const u of diff.addedUniques) statements.push({ sql: `ALTER TABLE ${table} ADD CONSTRAINT ${q(names.name("UQ", u.name, u.columns))} UNIQUE (${keyList(current, u.columns)})` });
  for (const ix of diff.addedIndexes) statements.push({ sql: indexSql(current, ix, names.name("IX", ix.name, ix.columns.map((k) => k.columnId))) });
  for (const fk of diff.addedForeignKeys) statements.push({ sql: foreignKeySql(current, fk, names.name("FK", fk.name, fk.columns)) });

  return { statements, recreate: false, warnings };
}
