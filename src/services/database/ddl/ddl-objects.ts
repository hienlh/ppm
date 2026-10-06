/**
 * The tree's table commands — Drop, Truncate, Rename, Create table backup — and New table, per
 * engine. Each is a plan like the table editor's, so it goes through the same Save changes dialog.
 */
import type { DbForeignKey } from "../../../shared/db-structure.ts";
import type { DialectName } from "../../../shared/db-types.ts";
import type { TableModel } from "../../../shared/db-table-model.ts";
import { mysqlDialect } from "../dialect-mysql.ts";
import { postgresDialect } from "../dialect-postgres.ts";
import { sqliteDialect } from "../dialect-sqlite.ts";
import { mysqlCreateTable } from "./ddl-mysql.ts";
import { postgresCreateTable } from "./ddl-postgres.ts";
import { sqliteCreateTable } from "./ddl-sqlite.ts";
import { DdlUnsupportedError, type DdlPlan, type DdlStatement } from "./ddl-types.ts";

export interface TableRef {
  schema: string | null;
  name: string;
}

const DIALECTS = { postgres: postgresDialect, mysql: mysqlDialect, sqlite: sqliteDialect };

const tableSql = (dialect: DialectName, t: TableRef) => (dialect === "sqlite" ? sqliteDialect.quoteIdent(t.name) : DIALECTS[dialect].qualify(t.name, t.schema));
const label = (t: TableRef) => (t.schema ? `${t.schema}.${t.name}` : t.name);

/** The keys other tables hold on `table`; its own keys onto itself go with it. */
function otherTablesKeys(table: TableRef, references: readonly DbForeignKey[]): DbForeignKey[] {
  return references.filter((fk) => !(fk.table === table.name && (fk.schema ?? null) === (table.schema ?? null)));
}

export function createTablePlan(dialect: DialectName, model: TableModel): DdlPlan {
  if (dialect === "postgres") return postgresCreateTable(model);
  if (dialect === "mysql") return mysqlCreateTable(model);
  return sqliteCreateTable(model);
}

/**
 * `DROP TABLE`, after the keys other tables hold on it, as DBGate drops them on Postgres — here on
 * MySQL too, which would otherwise refuse. SQLite cannot drop another table's key without
 * rebuilding that table, and with foreign keys enforced its DROP TABLE first deletes every row,
 * which cascades into the tables pointing at it — so while one does, it is refused instead.
 */
export function dropTablePlan(dialect: DialectName, table: TableRef, references: readonly DbForeignKey[]): DdlPlan {
  const statements: DdlStatement[] = [];
  const warnings: string[] = [];
  const others = otherTablesKeys(table, references);
  if (dialect === "sqlite") {
    if (others.length > 0) {
      const children = [...new Set(others.map((fk) => fk.table))];
      throw new DdlUnsupportedError(`${children.join(", ")} ${children.length === 1 ? "has a foreign key" : "have foreign keys"} onto ${table.name}: remove ${children.length === 1 ? "it" : "them"} in the Structure tab first, or drop ${children.join(", ")}`);
    }
  } else {
    for (const fk of others) {
      if (!fk.name) continue;
      const child = tableSql(dialect, { schema: fk.schema, name: fk.table });
      const drop = dialect === "mysql" ? "DROP FOREIGN KEY" : "DROP CONSTRAINT";
      statements.push({ sql: `ALTER TABLE ${child} ${drop} ${DIALECTS[dialect].quoteIdent(fk.name)}` });
      warnings.push(`Drops the foreign key ${fk.name} of ${label({ schema: fk.schema, name: fk.table })}, which points at ${table.name}`);
    }
  }
  statements.push({ sql: `DROP TABLE ${tableSql(dialect, table)}` });
  return { statements, recreate: false, warnings };
}

/**
 * `TRUNCATE TABLE`, and on SQLite, which has none, `DELETE FROM` as DBGate writes it. That one runs
 * the foreign keys' ON DELETE actions, which TRUNCATE never does, so the Save dialog says which.
 */
export function truncateTablePlan(dialect: DialectName, table: TableRef, references: readonly DbForeignKey[]): DdlPlan {
  if (dialect !== "sqlite") return { statements: [{ sql: `TRUNCATE TABLE ${tableSql(dialect, table)}` }], recreate: false, warnings: [] };
  const warnings: string[] = [];
  for (const fk of otherTablesKeys(table, references)) {
    const columns = fk.columns.join(", ");
    if (fk.onDelete === "CASCADE") warnings.push(`Also deletes the rows of ${fk.table} that point at ${table.name} (its foreign key on ${columns} is ON DELETE CASCADE)`);
    else if (fk.onDelete === "SET NULL") warnings.push(`Sets ${fk.table}.${columns} to NULL where it points at ${table.name} (ON DELETE SET NULL)`);
    else if (fk.onDelete === "SET DEFAULT") warnings.push(`Sets ${fk.table}.${columns} to its default where it points at ${table.name} (ON DELETE SET DEFAULT)`);
  }
  return { statements: [{ sql: `DELETE FROM ${tableSql(dialect, table)}` }], recreate: false, warnings };
}

export function renameTablePlan(dialect: DialectName, table: TableRef, newName: string): DdlPlan {
  const sql = dialect === "mysql"
    ? `RENAME TABLE ${tableSql(dialect, table)} TO ${tableSql(dialect, { schema: table.schema, name: newName })}`
    : `ALTER TABLE ${tableSql(dialect, table)} RENAME TO ${DIALECTS[dialect].quoteIdent(newName)}`;
  return { statements: [{ sql }], recreate: false, warnings: [] };
}

/**
 * A copy of the table with its rows, as DBGate's Create table backup makes one: the same columns
 * and primary key, and nothing that would tie it to the original or clash with its names — no
 * autoincrement, foreign keys, indexes, unique or CHECK constraints, and a primary key with no
 * name of its own. A computed column is not copied into, since it computes its own value.
 */
export function backupTablePlan(dialect: DialectName, source: TableModel, newName: string): DdlPlan {
  const copy: TableModel = {
    ...source,
    name: newName,
    columns: source.columns.map((c) => ({
      ...c,
      autoIncrement: false,
      identity: null,
      sqliteAutoincrement: false,
      // A serial's default is its sequence's nextval(), which the copy must not share.
      defaultValue: c.autoIncrement ? null : c.defaultValue,
    })),
    primaryKey: source.primaryKey ? { ...source.primaryKey, name: null } : null,
    indexes: [], uniques: [], foreignKeys: [], checks: [],
  };
  const plan = createTablePlan(dialect, copy);
  const quote = DIALECTS[dialect].quoteIdent;
  const columns = source.columns.filter((c) => !c.computedExpression?.trim()).map((c) => quote(c.name)).join(", ");
  plan.statements.push({
    sql: `INSERT INTO ${tableSql(dialect, { schema: source.schema, name: newName })} (${columns}) SELECT ${columns} FROM ${tableSql(dialect, source)}`,
  });
  return plan;
}
