/**
 * Read a MySQL or MariaDB database's structure from `information_schema`.
 *
 * A MySQL "schema" is a database, so every object carries the database it
 * lives in. A connection that names a database shows that one only; one that
 * names none shows every database the user can see except the server's own
 * (`mysql`, `sys`, `information_schema`, `performance_schema`).
 *
 * The two servers differ in a few catalog details, all measured on MySQL 8.4
 * and MariaDB 11.8:
 *
 * - `COLUMN_DEFAULT`: MySQL gives a literal *unquoted* (`abc`) and marks an
 *   expression with `DEFAULT_GENERATED` in `EXTRA`; MariaDB gives SQL text
 *   already (`'abc'`, `current_timestamp()`) and spells "no default" `NULL`.
 * - `CHECK_CONSTRAINTS` has a `TABLE_NAME` column on MariaDB only; MySQL is
 *   joined through `TABLE_CONSTRAINTS`.
 * - `STATISTICS.EXPRESSION` (functional index parts) exists from MySQL 8.0.13.
 * - A MariaDB sequence is a table whose `TABLE_TYPE` is `SEQUENCE`.
 */
import type {
  DbCheckConstraint, DbColumnRef, DbForeignKey, DbIndex, DbIndexKey, DbObject, DbObjectList, DbTableStructure, DbUniqueConstraint, FkAction,
} from "../../shared/db-structure.ts";
import type { DbCatalogTable, DbColumnInfo, DbTableInfo } from "../../types/database.ts";
import { mysqlDialect } from "./dialect-mysql.ts";

/** A parameterised read returning rows as objects keyed by the query's own aliases. */
export type MysqlRead = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export interface MysqlServerInfo {
  mariadb: boolean;
  /** Major, minor, patch. */
  version: [number, number, number];
  /** `NO_BACKSLASH_ESCAPES` is in the session's `sql_mode`, which changes how a statement is split. */
  noBackslashEscapes: boolean;
  /** The database the connection opens, or null when it names none. */
  database: string | null;
}

/** The server's own databases, hidden from the tree the way Postgres' `pg_catalog` is. */
export const MYSQL_SYSTEM_SCHEMAS = ["information_schema", "mysql", "performance_schema", "sys"] as const;

const FK_ACTIONS = new Set<FkAction>(["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"]);

/** `SELECT VERSION()`: `8.4.11`, `11.8.9-MariaDB-ubu2404`, and on some MariaDB builds a `5.5.5-` prefix. */
export function parseServerVersion(text: string): Pick<MysqlServerInfo, "mariadb" | "version"> {
  const mariadb = /mariadb/i.test(text);
  const [major = 0, minor = 0, patch = 0] = text.replace(/^5\.5\.5-/, "").split(/[^0-9]/, 3).map(Number);
  return { mariadb, version: [major, minor, patch] };
}

export async function mysqlServerInfo(read: MysqlRead): Promise<MysqlServerInfo> {
  const [row] = await read("SELECT VERSION() AS version, @@SESSION.sql_mode AS sql_mode, DATABASE() AS db");
  return {
    ...parseServerVersion(text(row?.version)),
    noBackslashEscapes: /\bNO_BACKSLASH_ESCAPES\b/i.test(text(row?.sql_mode)),
    database: row?.db == null ? null : text(row.db),
  };
}

function atLeast(info: MysqlServerInfo, major: number, minor: number, patch: number): boolean {
  const [a, b, c] = info.version;
  return a !== major ? a > major : b !== minor ? b > minor : c >= patch;
}

/** Catalog text; a few `information_schema` columns come back as bytes on some builds. */
function text(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return String(value);
}

function nullableText(value: unknown): string | null {
  const t = text(value);
  return t === "" ? null : t;
}

/** The databases a query may look at, as a condition on `column` plus its parameters. */
function scope(info: MysqlServerInfo, column: string): { where: string; params: unknown[] } {
  if (info.database !== null) return { where: `${column} = ?`, params: [info.database] };
  return { where: `${column} NOT IN (${MYSQL_SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(", ")})`, params: [] };
}

function fkAction(value: unknown): FkAction {
  const t = text(value).toUpperCase() as FkAction;
  return FK_ACTIONS.has(t) ? t : "NO ACTION";
}

const FOREIGN_KEYS = `
  SELECT k.CONSTRAINT_NAME AS fk_name, k.TABLE_SCHEMA AS db, k.TABLE_NAME AS tbl, k.COLUMN_NAME AS col,
         k.REFERENCED_TABLE_SCHEMA AS ref_db, k.REFERENCED_TABLE_NAME AS ref_tbl, k.REFERENCED_COLUMN_NAME AS ref_col,
         r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
  FROM information_schema.KEY_COLUMN_USAGE k
  JOIN information_schema.REFERENTIAL_CONSTRAINTS r
    ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
  WHERE k.REFERENCED_TABLE_NAME IS NOT NULL`;

const FK_ORDER = "ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION";

/** One row per key column, folded into one key per constraint in column order. */
function foldForeignKeys(rows: Record<string, unknown>[]): DbForeignKey[] {
  const keys = new Map<string, DbForeignKey>();
  for (const r of rows) {
    const id = `${text(r.db)}\u0000${text(r.tbl)}\u0000${text(r.fk_name)}`;
    let fk = keys.get(id);
    if (!fk) {
      fk = {
        name: text(r.fk_name),
        schema: text(r.db),
        table: text(r.tbl),
        columns: [],
        refSchema: text(r.ref_db),
        refTable: text(r.ref_tbl),
        refColumns: [],
        onDelete: fkAction(r.on_delete),
        onUpdate: fkAction(r.on_update),
      };
      keys.set(id, fk);
    }
    fk.columns.push(text(r.col));
    fk.refColumns.push(text(r.ref_col));
  }
  return [...keys.values()];
}

/**
 * Every user foreign key on the server, not only the connection's database:
 * a key in another database can still point at a row being deleted here.
 */
export async function mysqlListForeignKeys(read: MysqlRead): Promise<DbForeignKey[]> {
  const system = MYSQL_SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(", ");
  return foldForeignKeys(await read(`${FOREIGN_KEYS} AND k.TABLE_SCHEMA NOT IN (${system}) ${FK_ORDER}`));
}

const TABLE_KINDS: Record<string, DbObject["kind"]> = {
  "BASE TABLE": "table", "SYSTEM VERSIONED": "table", VIEW: "view", "SYSTEM VIEW": "view", SEQUENCE: "sequence",
};

export async function mysqlListObjects(read: MysqlRead, info: MysqlServerInfo): Promise<DbObjectList> {
  const tables = scope(info, "TABLE_SCHEMA");
  const routines = scope(info, "ROUTINE_SCHEMA");
  const triggers = scope(info, "TRIGGER_SCHEMA");
  const schemata = scope(info, "SCHEMA_NAME");
  const [schemaRows, relations, routineRows, triggerRows] = await Promise.all([
    info.database !== null
      ? Promise.resolve([{ db: info.database }])
      : read(`SELECT SCHEMA_NAME AS db FROM information_schema.SCHEMATA WHERE ${schemata.where} ORDER BY 1`, schemata.params),
    read(`SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, TABLE_TYPE AS kind, TABLE_ROWS AS row_estimate
          FROM information_schema.TABLES WHERE ${tables.where} ORDER BY 1, 2`, tables.params),
    read(`SELECT ROUTINE_SCHEMA AS db, ROUTINE_NAME AS name, ROUTINE_TYPE AS kind
          FROM information_schema.ROUTINES WHERE ${routines.where} ORDER BY 1, 2`, routines.params),
    read(`SELECT TRIGGER_SCHEMA AS db, TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl
          FROM information_schema.TRIGGERS WHERE ${triggers.where} ORDER BY 1, 3, 2`, triggers.params),
  ]);

  const objects: DbObject[] = [];
  for (const r of relations) {
    const kind = TABLE_KINDS[text(r.kind).toUpperCase()] ?? "table";
    const obj: DbObject = { schema: text(r.db), name: text(r.name), kind };
    // InnoDB's figure is an estimate, like Postgres' reltuples; views have none.
    const estimate = r.row_estimate == null ? NaN : Number(r.row_estimate);
    if (kind === "table" && Number.isFinite(estimate) && estimate >= 0) obj.rowEstimate = estimate;
    objects.push(obj);
  }
  for (const r of routineRows) {
    objects.push({ schema: text(r.db), name: text(r.name), kind: text(r.kind).toUpperCase() === "PROCEDURE" ? "procedure" : "function" });
  }
  for (const r of triggerRows) {
    objects.push({ schema: text(r.db), name: text(r.name), kind: "trigger", table: text(r.tbl) });
  }
  return { schemas: schemaRows.map((r) => text(r.db)), objects };
}

export async function mysqlListColumns(read: MysqlRead, info: MysqlServerInfo): Promise<DbColumnRef[]> {
  const s = scope(info, "TABLE_SCHEMA");
  const rows = await read(`SELECT TABLE_SCHEMA AS db, TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type
    FROM information_schema.COLUMNS WHERE ${s.where} ORDER BY 1, 2, ORDINAL_POSITION`, s.params);
  return rows.map((r) => ({ schema: text(r.db), table: text(r.tbl), name: text(r.name), type: text(r.type) }));
}

/** Tables with the engine's row estimate, for the table cache behind search. */
export async function mysqlListTables(read: MysqlRead, info: MysqlServerInfo): Promise<DbTableInfo[]> {
  const s = scope(info, "TABLE_SCHEMA");
  const rows = await read(`
    SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, TABLE_ROWS AS row_estimate
    FROM information_schema.TABLES
    WHERE TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED') AND ${s.where}
    ORDER BY 1, 2`, s.params);
  return rows.map((r) => ({ schema: text(r.db), name: text(r.name), rowCount: Number(r.row_estimate) || 0 }));
}

/** Columns and primary key of a table or view; null when there is none by that name. */
export async function mysqlDescribeTable(read: MysqlRead, table: string, schema: string | null): Promise<DbCatalogTable | null> {
  const rows = await read(`
    SELECT c.COLUMN_NAME AS name, c.COLUMN_TYPE AS col_type, k.ORDINAL_POSITION AS pk
    FROM information_schema.COLUMNS c
    LEFT JOIN information_schema.KEY_COLUMN_USAGE k
      ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME
     AND k.CONSTRAINT_NAME = 'PRIMARY'
    WHERE c.TABLE_SCHEMA = COALESCE(?, DATABASE()) AND c.TABLE_NAME = ?
    ORDER BY c.ORDINAL_POSITION`, [schema, table]);
  if (rows.length === 0) return null;
  const rowKey = rows
    .filter((r) => r.pk != null)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((r) => text(r.name));
  return { columns: rows.map((r) => ({ name: text(r.name), type: text(r.col_type) })), rowKey, rowKeyIsRowid: false, rowidAliases: [] };
}

/** The older column list the grid's cell kinds and the CLI's `ppm db schema` read. */
export async function mysqlTableColumns(read: MysqlRead, table: string, schema: string | null): Promise<DbColumnInfo[]> {
  const [cols, fks] = await Promise.all([
    read(`
      SELECT COLUMN_NAME AS name, COLUMN_TYPE AS col_type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS default_value,
             COLUMN_KEY AS col_key, EXTRA AS extra
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`, [schema, table]),
    read(`${FOREIGN_KEYS} AND k.TABLE_SCHEMA = COALESCE(?, DATABASE()) AND k.TABLE_NAME = ? ${FK_ORDER}`, [schema, table]),
  ]);
  const fkByColumn = new Map<string, { table: string; column: string }>();
  for (const r of fks) fkByColumn.set(text(r.col), { table: text(r.ref_tbl), column: text(r.ref_col) });
  return cols.map((c) => ({
    name: text(c.name),
    type: text(c.col_type),
    nullable: text(c.nullable) === "YES",
    pk: text(c.col_key) === "PRI",
    defaultValue: c.default_value == null ? null : text(c.default_value),
    autoIncrement: /auto_increment/i.test(text(c.extra)),
    fk: fkByColumn.get(text(c.name)) ?? null,
  }));
}

const NUMERIC_DATA_TYPE = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)$/i;
const CURRENT_TIMESTAMP = /^(current_timestamp|now|localtime|localtimestamp)(\(\d*\))?$/i;

/** A column default as SQL text, whichever server described it. */
export function columnDefaultSql(info: Pick<MysqlServerInfo, "mariadb">, raw: unknown, extra: string, dataType: string): string | null {
  if (raw == null) return null;
  const value = text(raw);
  // MariaDB already prints SQL, and prints a missing default as NULL.
  if (info.mariadb) return value.toUpperCase() === "NULL" ? null : value;
  if (/DEFAULT_GENERATED/i.test(extra)) return CURRENT_TIMESTAMP.test(value) ? value : `(${value})`;
  if (NUMERIC_DATA_TYPE.test(dataType) || /^b'[01]*'$/i.test(value)) return value;
  return mysqlDialect.literal(value);
}

/** Computed from other columns: MySQL and MariaDB 10.2+ say `VIRTUAL GENERATED`/`STORED GENERATED`, older MariaDB `VIRTUAL`/`PERSISTENT`. */
function isGenerated(extra: string): boolean {
  return /\b(VIRTUAL|STORED) GENERATED\b/i.test(extra) || /^(VIRTUAL|PERSISTENT)$/i.test(extra.trim());
}

function isStoredGenerated(extra: string): boolean {
  return /\bSTORED GENERATED\b/i.test(extra) || /^PERSISTENT$/i.test(extra.trim());
}

/**
 * `on update CURRENT_TIMESTAMP` from `EXTRA` (MySQL writes `DEFAULT_GENERATED on update …` for a
 * column that also has an expression default; MariaDB `on update current_timestamp()`).
 */
export function onUpdateOf(extra: string): string | null {
  return /\bon update\s+(\S+)/i.exec(extra)?.[1] ?? null;
}

export async function mysqlGetStructure(
  read: MysqlRead, info: MysqlServerInfo, schema: string | null, table: string,
): Promise<DbTableStructure | null> {
  const [rel] = await read(`
    SELECT TABLE_SCHEMA AS db, TABLE_TYPE AS kind, TABLE_COMMENT AS comment_text, ENGINE AS engine, TABLE_COLLATION AS collation_name
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?`, [schema, table]);
  if (!rel) return null;
  const db = text(rel.db);
  const isView = TABLE_KINDS[text(rel.kind).toUpperCase()] === "view";
  const expression = !info.mariadb && atLeast(info, 8, 0, 13) ? ", EXPRESSION AS expr" : "";
  // Generated columns came with MySQL 5.7.6 and MariaDB 10.2.
  const generation = (info.mariadb ? atLeast(info, 10, 2, 0) : atLeast(info, 5, 7, 6)) ? "GENERATION_EXPRESSION" : "NULL";

  const [columns, indexRows, keyRows, foreignKeys, references, checks] = await Promise.all([
    read(`
      SELECT COLUMN_NAME AS name, COLUMN_TYPE AS col_type, DATA_TYPE AS data_type, IS_NULLABLE AS nullable,
             COLUMN_DEFAULT AS default_value, COLUMN_COMMENT AS comment_text, EXTRA AS extra, ${generation} AS generation,
             COLLATION_NAME AS collation_name
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`, [db, table]),
    read(`
      SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS col, SUB_PART AS sub_part, INDEX_TYPE AS method,
             COLLATION AS direction${expression}
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [db, table]),
    read(`
      SELECT tc.CONSTRAINT_NAME AS name, tc.CONSTRAINT_TYPE AS kind, k.COLUMN_NAME AS col
      FROM information_schema.TABLE_CONSTRAINTS tc
      JOIN information_schema.KEY_COLUMN_USAGE k
        ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
       AND k.TABLE_SCHEMA = tc.TABLE_SCHEMA AND k.TABLE_NAME = tc.TABLE_NAME
      WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')
      ORDER BY tc.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [db, table]),
    read(`${FOREIGN_KEYS} AND k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? ${FK_ORDER}`, [db, table]),
    read(`${FOREIGN_KEYS} AND k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ? ${FK_ORDER}`, [db, table]),
    readChecks(read, info, db, table),
  ]);

  const indexes = new Map<string, DbIndex>();
  for (const r of indexRows) {
    const name = text(r.name);
    let index = indexes.get(name);
    if (!index) {
      index = { name, columns: [], keys: [], unique: Number(r.non_unique) === 0, primary: name === "PRIMARY", where: null, method: nullableText(r.method)?.toLowerCase() ?? null };
      indexes.set(name, index);
    }
    // A functional key part has no column, only its expression; a prefix index keeps its length.
    const col = r.col == null ? `(${text(r.expr)})` : text(r.col);
    index.columns.push(r.sub_part == null ? col : `${col}(${Number(r.sub_part)})`);
    // COLLATION is A or D, and NULL for a key with no order (FULLTEXT, HASH).
    const key: DbIndexKey = { column: r.col == null ? null : text(r.col), expression: r.col == null ? text(r.expr) : null, descending: text(r.direction) === "D" };
    if (r.sub_part != null) key.length = Number(r.sub_part);
    index.keys.push(key);
  }

  const pkColumns = keyRows.filter((r) => text(r.kind) === "PRIMARY KEY").map((r) => text(r.col));
  const uniques = new Map<string, DbUniqueConstraint>();
  for (const r of keyRows) {
    if (text(r.kind) !== "UNIQUE") continue;
    const name = text(r.name);
    let u = uniques.get(name);
    if (!u) uniques.set(name, u = { name, columns: [] });
    u.columns.push(text(r.col));
  }
  const primaryKey = pkColumns.length > 0 ? { name: "PRIMARY", columns: pkColumns } : null;
  const tableCollation = nullableText(rel.collation_name);

  return {
    schema: db,
    name: table,
    kind: isView ? "view" : "table",
    columns: columns.map((c) => {
      const extra = text(c.extra);
      const generated = isGenerated(extra);
      return {
        name: text(c.name),
        type: text(c.col_type),
        nullable: text(c.nullable) === "YES",
        defaultValue: generated ? null : columnDefaultSql(info, c.default_value, extra, text(c.data_type)),
        comment: nullableText(c.comment_text),
        autoIncrement: /auto_increment/i.test(extra),
        generated,
        computedExpression: generated ? nullableText(c.generation) : null,
        // CHANGE COLUMN restates the column, and one saying no collation takes the table's.
        collation: nullableText(c.collation_name) !== tableCollation ? nullableText(c.collation_name) : null,
        ...(generated ? { computedStored: isStoredGenerated(extra) } : {}),
        onUpdate: onUpdateOf(extra),
      };
    }),
    primaryKey,
    foreignKeys: foldForeignKeys(foreignKeys),
    references: foldForeignKeys(references),
    indexes: [...indexes.values()],
    uniques: [...uniques.values()],
    checks,
    // MySQL fills a view's TABLE_COMMENT with the word VIEW.
    comment: isView ? null : nullableText(rel.comment_text),
    engine: isView ? null : nullableText(rel.engine),
    rowKey: primaryKey?.columns ?? [],
    rowKeyIsRowid: false,
  };
}

/** CHECK constraints, which older servers (MySQL before 8.0.16) do not list at all. */
async function readChecks(read: MysqlRead, info: MysqlServerInfo, db: string, table: string): Promise<DbCheckConstraint[]> {
  const sql = info.mariadb
    ? `SELECT CONSTRAINT_NAME AS name, CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? ORDER BY 1`
    : `SELECT cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
       WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK' ORDER BY 1`;
  try {
    const rows = await read(sql, [db, table]);
    return rows.map((r) => ({ name: text(r.name), expression: text(r.clause) }));
  } catch {
    return [];
  }
}
