/**
 * Rebuilding a SQLite table — the change SQLite's ALTER TABLE cannot make — by the twelve steps
 * of its own documentation (https://www.sqlite.org/lang_altertable.html#otheralter): foreign keys
 * off outside the transaction, create `new_X`, copy the rows, drop `X`, rename `new_X` to `X`,
 * recreate the indexes and triggers, check the foreign keys, foreign keys back on — the three
 * foreign-key steps only where the connection enforces them, as the documentation has it.
 *
 * Not DBGate's way, which renames `X` to a temporary name first: since SQLite 3.26 renaming a
 * table rewrites the foreign keys of the tables pointing at it, so every child ended up pointing
 * at the temporary table, and then at nothing once it was dropped.
 *
 * Three things the documentation leaves to the reader, each measured on SQLite 3.51:
 *
 * - Renaming `new_X` fails with "error in view v: no such table: main.X" as soon as any view or
 *   trigger names `X`, because the rename re-reads the whole schema while `X` is gone.
 *   `PRAGMA legacy_alter_table` skips that check for the one statement that needs it; it also
 *   skips rewriting the children, which point at `X` and should.
 * - With that check skipped nothing notices a view left naming a dropped column, so PPM compiles
 *   every view and trigger that names the table before committing (preparing a statement compiles
 *   the triggers it fires, without running it).
 * - Columns are renamed first, in place, with `RENAME COLUMN`: SQLite then rewrites the views,
 *   triggers, indexes and checks that name them — something only its own parser can do right —
 *   and the rebuild copies what it wrote (`SqliteSchemaText` is read after those renames).
 */
import type { DbCheckConstraint } from "../../../shared/db-structure.ts";
import { columnById, type TableModel, type TableModelColumn } from "../../../shared/db-table-model.ts";
import { ROWID_ALIASES } from "../analyser-sqlite.ts";
import { sqliteDialect } from "../dialect-sqlite.ts";
import { ConstraintNamer, filled } from "./ddl-common.ts";
import {
  sqliteAtLeast, sqliteColumnChecks, sqliteColumnDefinition, sqliteConstraintLines, sqliteIndexSql, sqliteInlineKey, type SqliteVersion,
} from "./ddl-sqlite.ts";
import type { DdlPlan, DdlStatement } from "./ddl-types.ts";
import { orderRenames, type RenameStep, type TableDiff } from "./table-diff.ts";

/** The parts of the table's schema a rebuild copies rather than writes from the model, as they read after the plan's renames. */
export interface SqliteSchemaText {
  /** The table's own `CREATE TABLE`, for what the rebuild cannot say again. */
  createSql: string;
  /** A column's own checks name it, and go with it when it is dropped. */
  checks: DbCheckConstraint[];
  /** Generated columns' expressions, by lowercased column name. */
  generated: Map<string, string>;
  /** Each index's `CREATE INDEX`, by name; SQLite's own indexes for keys have none. */
  indexes: Map<string, string>;
  /** The table's triggers, which go with it when it is dropped. */
  triggers: string[];
  /** Every name in the schema — tables, views, indexes and triggers share one namespace — lowercased, so the new table's name is free. */
  objectNames: Set<string>;
  /** The table has a row in `sqlite_sequence` (it was AUTOINCREMENT and has held rows). */
  hasSequence: boolean;
}

const q = sqliteDialect.quoteIdent;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The column that is the rowid, when there is one: a one-column INTEGER primary key of a table that has rowids. */
function rowidAlias(model: TableModel, inlineKey: string | null): string | null {
  if (model.withoutRowid) return null;
  if (inlineKey) return inlineKey;
  const pk = model.primaryKey;
  if (!pk || pk.columns.length !== 1) return null;
  const c = columnById(model, pk.columns[0]!);
  return c && c.type.trim().toUpperCase() === "INTEGER" ? c.id : null;
}

/** Clauses the rebuilt `CREATE TABLE` does not say again, found in the old one's text. */
function lostClauses(createSql: string): string[] {
  const text = createSql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/g, "''");
  const lost: string[] = [];
  if (/\bDEFERRABLE\b/i.test(text)) lost.push("DEFERRABLE on a foreign key");
  if (/\bON\s+CONFLICT\b/i.test(text)) lost.push("an ON CONFLICT clause");
  if (/\bMATCH\s+\w+/i.test(text)) lost.push("a foreign key's MATCH clause");
  return lost;
}

/**
 * The column renames a rebuild makes in place before anything else, in the order it makes them
 * — which is also how the schema text it copies must be read (`SqliteSchemaText`). The columns it
 * drops are still there at that point, so one holding a name a rename needs is moved aside first:
 * a view naming it then fails the rebuild's check, rather than quietly reading the renamed column.
 */
export function sqliteRebuildRenames(base: TableModel, diff: TableDiff, version: SqliteVersion): RenameStep[] {
  if (!sqliteAtLeast(version, 3, 25, 0)) return [];
  const targets = new Set(diff.renamedColumns.map((r) => r.after.name.toLowerCase()));
  const names = new Set(base.columns.map((c) => c.name.toLowerCase()));
  const steps: RenameStep[] = [];
  let n = 0;
  for (const c of diff.droppedColumns) {
    if (!targets.has(c.name.toLowerCase())) continue;
    let aside = `__ppm_dropped_${++n}`;
    while (names.has(aside)) aside = `__ppm_dropped_${++n}`;
    names.add(aside);
    steps.push({ from: c.name, to: aside });
  }
  const renamedIds = new Set(diff.renamedColumns.map((r) => r.after.id));
  const asideNames = new Set(steps.map((s) => s.from.toLowerCase()));
  const staying = base.columns.filter((c) => !renamedIds.has(c.id) && !asideNames.has(c.name.toLowerCase())).map((c) => c.name);
  return [...steps, ...orderRenames(diff.renamedColumns.map((r) => ({ from: r.before.name, to: r.after.name })), [...staying, ...steps.map((s) => s.to)], true)];
}

export interface SqliteRecreateContext {
  version: SqliteVersion;
  /** The connection enforces foreign keys (`PRAGMA foreign_keys`); PPM's own handles always do. */
  foreignKeys: boolean;
  schema: SqliteSchemaText;
  /** Why the table is rebuilt, for the Save dialog. */
  reason: string;
}

export function sqliteRecreatePlan(base: TableModel, current: TableModel, diff: TableDiff, ctx: SqliteRecreateContext): DdlPlan {
  const table = current.name;
  const statements: DdlStatement[] = [];
  const warnings: string[] = [ctx.reason];

  let temp = `new_${table}`;
  for (let n = 2; ctx.schema.objectNames.has(temp.toLowerCase()); n++) temp = `new_${table}_${n}`;

  if (ctx.foreignKeys) statements.push({ sql: "PRAGMA foreign_keys = OFF", phase: "before" });

  // Renames in place first, so SQLite rewrites what names the columns (see the header).
  const nativeRenames = sqliteAtLeast(ctx.version, 3, 25, 0);
  for (const step of sqliteRebuildRenames(base, diff, ctx.version)) {
    statements.push({ sql: `ALTER TABLE ${q(table)} RENAME COLUMN ${q(step.from)} TO ${q(step.to)}` });
  }

  const inline = sqliteInlineKey(current, base);
  const alteredExpression = new Set(diff.alteredColumns
    .filter((p) => filled(p.before.computedExpression) !== filled(p.after.computedExpression))
    .map((p) => p.after.id));
  const computedOf = (c: TableModelColumn) => {
    if (!filled(c.computedExpression)) return null;
    // What SQLite wrote after the renames, unless the user wrote a new expression.
    return alteredExpression.has(c.id) ? filled(c.computedExpression) : ctx.schema.generated.get(c.name.toLowerCase()) ?? filled(c.computedExpression);
  };
  const names = new ConstraintNamer(current, true, current.indexes.map((x) => x.name).filter(Boolean));
  const body = current.columns.map((c) => `  ${sqliteColumnDefinition(c, {
    inlineKey: c.id === inline.column, autoincrement: inline.autoincrement, computed: computedOf(c), checks: sqliteColumnChecks(ctx.schema.checks, c.name),
  })}`);
  for (const line of sqliteConstraintLines(current, { inlineKeyColumn: inline.column, names, checks: ctx.schema.checks })) body.push(`  ${line}`);
  const options = [current.withoutRowid ? "WITHOUT ROWID" : "", current.strict ? "STRICT" : ""].filter(Boolean).join(", ");
  statements.push({ sql: `CREATE TABLE ${q(temp)} (\n${body.join(",\n")}\n)${options ? ` ${options}` : ""}` });

  // The rows: every column that was there before and is not computed now.
  const baseById = new Map(base.columns.map((c) => [c.id, c]));
  const targets: string[] = [];
  const sources: string[] = [];
  let copiesRowidAlias = false;
  const alias = rowidAlias(current, inline.column);
  for (const c of current.columns) {
    const was = baseById.get(c.id);
    if (!was || filled(c.computedExpression)) continue;
    const from = q(nativeRenames ? c.name : was.name);
    const def = filled(c.defaultValue);
    // A column turning NOT NULL takes its default where it was NULL, as UPDATE … WHERE IS NULL does elsewhere.
    targets.push(q(c.name));
    sources.push(c.notNull && !was.notNull && def ? `COALESCE(${from}, ${def})` : from);
    if (c.id === alias) copiesRowidAlias = true;
  }
  // A table with rowids keeps them — a rebuilt table would otherwise renumber its rows from 1 —
  // unless a column that is the rowid is copied already, and then it carries them. The rowid has
  // three names, and a column can take any of them.
  const taken = new Set([...base.columns, ...current.columns].map((c) => c.name.toLowerCase()));
  const rowid = ROWID_ALIASES.find((name) => !taken.has(name));
  if (!base.withoutRowid && !current.withoutRowid && !copiesRowidAlias && rowid) {
    targets.unshift(rowid);
    sources.unshift(rowid);
  }
  if (targets.length > 0) statements.push({ sql: `INSERT INTO ${q(temp)} (${targets.join(", ")}) SELECT ${sources.join(", ")} FROM ${q(table)}` });
  else warnings.push(`No column of ${table} is kept, so neither are its rows`);

  // AUTOINCREMENT never hands out a rowid it gave before, which a new table would not know about.
  if (ctx.schema.hasSequence && inline.autoincrement) {
    const seq = q("sqlite_sequence");
    statements.push({ sql: `UPDATE ${seq} SET "seq" = max("seq", (SELECT "seq" FROM ${seq} WHERE "name" = ${lit(table)})) WHERE "name" = ${lit(temp)}` });
    statements.push({ sql: `INSERT INTO ${seq} ("name", "seq") SELECT ${lit(temp)}, "seq" FROM ${seq} WHERE "name" = ${lit(table)} AND NOT EXISTS (SELECT 1 FROM ${seq} WHERE "name" = ${lit(temp)})` });
  }

  statements.push({ sql: `DROP TABLE ${q(table)}` });
  statements.push({ sql: "PRAGMA legacy_alter_table = ON" });
  statements.push({ sql: `ALTER TABLE ${q(temp)} RENAME TO ${q(table)}` });
  statements.push({ sql: "PRAGMA legacy_alter_table = OFF" });

  // Indexes: an unchanged one as SQLite wrote it after the renames; a new or changed one from the model.
  const added = new Set(diff.addedIndexes.map((ix) => ix.id));
  const baseIndexes = new Map(base.indexes.map((ix) => [ix.id, ix]));
  for (const ix of current.indexes) {
    const kept = !added.has(ix.id) ? ctx.schema.indexes.get(baseIndexes.get(ix.id)?.name ?? ix.name) : undefined;
    statements.push({ sql: kept ?? sqliteIndexSql(current, ix, names.name("IX", ix.name, ix.columns.map((k) => k.columnId))) });
  }
  for (const trigger of ctx.schema.triggers) statements.push({ sql: trigger });

  statements.push({ sql: `-- PPM compiles every view and trigger, which the rebuild can leave naming what ${table} no longer has`, check: "schema", table });
  if (ctx.foreignKeys) {
    statements.push({ sql: "PRAGMA foreign_key_check", check: "foreign-keys", table });
    statements.push({ sql: "PRAGMA foreign_keys = ON", phase: "after" });
  }

  const lost = lostClauses(ctx.schema.createSql);
  if (lost.length > 0) warnings.push(`The rebuilt table does not keep ${lost.join(", ")}`);
  return { statements, recreate: true, warnings };
}
