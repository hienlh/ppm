/**
 * Read a Postgres database's structure from `pg_catalog`. `information_schema`
 * is not used: it hides objects the current user has no privilege on, spells
 * every type in SQL-standard words (`character varying` without its length),
 * and cannot say which keys point *at* a table without a slow join.
 *
 * `version` is `server_version_num` (e.g. 160004): a few catalog columns are
 * newer than the servers PPM still meets (`prokind` 11, `indnkeyatts` 11,
 * `conparentid` 11, `attidentity` 10, `attgenerated` 12).
 */
import type postgres from "postgres";
import type {
  DbCheckConstraint, DbColumnRef, DbForeignKey, DbIndex, DbIndexKey, DbObject, DbObjectList, DbTableStructure, DbUniqueConstraint, FkAction,
} from "../../shared/db-structure.ts";

const FK_ACTIONS: Record<string, FkAction> = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };

/** Postgres' own schemas, and the per-session ones it creates for temporary and TOAST tables. */
const USER_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'`;

/** Column names of a key, in key order, as a `text[]`. `attnums` is `conkey` or `confkey`, `rel` the table they belong to. */
function keyColumns(attnums: string, rel: string): string {
  return `ARRAY(SELECT a.attname::text FROM unnest(${attnums}) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = ${rel} AND a.attnum = k.attnum ORDER BY k.ord)`;
}

/** Only a partitioned table's own key: Postgres clones it onto every partition, and each clone points back with `conparentid`. */
function topLevelConstraint(version: number): string {
  return version >= 110000 ? "AND con.conparentid = 0" : "";
}

/** `indoption` bits: DESC, and NULLS FIRST — which is DESC's default and ASC's opposite. */
const INDOPTION_DESC = 1;
const INDOPTION_NULLS_FIRST = 2;

interface PgIndexKeyRow { column: string | null; expression: string | null; option: number | null; opclass: string | null }

function indexKeys(raw: unknown, method: string | null): DbIndexKey[] {
  const rows = (typeof raw === "string" ? JSON.parse(raw) : raw ?? []) as PgIndexKeyRow[];
  // Only an ordered access method (btree) has a direction; gin and gist keep no such option.
  const ordered = method === null || method === "btree";
  return rows.map((r) => {
    const option = Number(r.option ?? 0);
    const descending = ordered && (option & INDOPTION_DESC) !== 0;
    const nullsFirst = (option & INDOPTION_NULLS_FIRST) !== 0;
    const key: DbIndexKey = { column: r.expression ? null : r.column, expression: r.expression ?? null, descending };
    if (ordered && nullsFirst !== descending) key.nulls = nullsFirst ? "first" : "last";
    if (r.opclass) key.opclass = r.opclass;
    return key;
  });
}

function fkAction(code: unknown): FkAction {
  return FK_ACTIONS[String(code)] ?? "NO ACTION";
}

function toForeignKey(r: postgres.Row): DbForeignKey {
  return {
    name: r.name as string,
    schema: r.schema as string,
    table: r.table as string,
    columns: r.columns as string[],
    refSchema: r.ref_schema as string,
    refTable: r.ref_table as string,
    refColumns: r.ref_columns as string[],
    onDelete: fkAction(r.on_delete),
    onUpdate: fkAction(r.on_update),
  };
}

function foreignKeysQuery(version: number, where: string): string {
  return `
    SELECT con.conname AS name, n.nspname AS schema, c.relname AS table, ${keyColumns("con.conkey", "con.conrelid")} AS columns,
           fn.nspname AS ref_schema, fc.relname AS ref_table, ${keyColumns("con.confkey", "con.confrelid")} AS ref_columns,
           con.confdeltype AS on_delete, con.confupdtype AS on_update
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid
    JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
    WHERE con.contype = 'f' ${topLevelConstraint(version)} ${where}
    ORDER BY n.nspname, c.relname, con.conname`;
}

export async function pgServerVersion(sql: postgres.Sql): Promise<number> {
  const [row] = await sql`SELECT current_setting('server_version_num')::int AS v`;
  return Number(row?.v ?? 0);
}

export async function pgListObjects(sql: postgres.Sql, version: number): Promise<DbObjectList> {
  const routineKind = version >= 110000
    ? `CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END`
    : `'function'`;
  // Aggregates and window functions are not something a person opens from the tree.
  const routineFilter = version >= 110000 ? `p.prokind IN ('f', 'p')` : `NOT p.proisagg AND NOT p.proiswindow`;
  const [schemas, relations, routines, triggers] = await Promise.all([
    sql.unsafe(`SELECT n.nspname AS name FROM pg_catalog.pg_namespace n WHERE ${USER_SCHEMA} ORDER BY 1`),
    sql.unsafe(`
      SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.reltuples::float8 AS estimate
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S') AND ${USER_SCHEMA}
      ORDER BY 1, 2`),
    sql.unsafe(`
      SELECT n.nspname AS schema, p.proname AS name, ${routineKind} AS kind,
             pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE ${routineFilter} AND ${USER_SCHEMA}
      ORDER BY 1, 2, 4`),
    sql.unsafe(`
      SELECT n.nspname AS schema, t.tgname AS name, c.relname AS table
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND ${USER_SCHEMA}
      ORDER BY 1, 3, 2`),
  ]);

  const objects: DbObject[] = [];
  for (const r of relations) {
    const kind = ({ r: "table", p: "table", f: "table", v: "view", m: "matview", S: "sequence" } as const)[r.kind as "r"];
    const obj: DbObject = { schema: r.schema as string, name: r.name as string, kind };
    const estimate = Number(r.estimate);
    // -1 means "never analyzed" since Postgres 14; before that 0 meant the same.
    if ((kind === "table" || kind === "matview") && Number.isFinite(estimate) && estimate >= 0) obj.rowEstimate = Math.round(estimate);
    objects.push(obj);
  }
  for (const r of routines) {
    objects.push({ schema: r.schema as string, name: r.name as string, kind: r.kind as "function" | "procedure", args: r.args as string });
  }
  for (const r of triggers) {
    objects.push({ schema: r.schema as string, name: r.name as string, kind: "trigger", table: r.table as string });
  }
  return { schemas: schemas.map((r) => r.name as string), objects };
}

export async function pgListColumns(sql: postgres.Sql): Promise<DbColumnRef[]> {
  const rows = await sql.unsafe(`
    SELECT n.nspname AS schema, c.relname AS table, a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'f', 'v', 'm') AND ${USER_SCHEMA}
    ORDER BY 1, 2, a.attnum`);
  return rows.map((r) => ({ schema: r.schema as string, table: r.table as string, name: r.name as string, type: r.type as string }));
}

export async function pgListForeignKeys(sql: postgres.Sql, version: number): Promise<DbForeignKey[]> {
  const rows = await sql.unsafe(foreignKeysQuery(version, `AND ${USER_SCHEMA}`));
  return rows.map(toForeignKey);
}

export async function pgGetStructure(sql: postgres.Sql, version: number, schema: string, table: string): Promise<DbTableStructure | null> {
  const [rel] = await sql`
    SELECT c.oid, c.relkind AS kind, pg_catalog.obj_description(c.oid, 'pg_class') AS comment
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = ${table} AND c.relkind IN ('r', 'p', 'f', 'v', 'm')`;
  if (!rel) return null;
  const oid = rel.oid as number;

  const identity = version >= 100000 ? "a.attidentity" : "''";
  const generated = version >= 120000 ? "a.attgenerated" : "''";
  const keyAtts = version >= 110000 ? "i.indnkeyatts" : "i.indnatts";

  const [columns, constraints, references, indexes] = await Promise.all([
    sql.unsafe(`
      SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
             pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value, pg_catalog.col_description(a.attrelid, a.attnum) AS comment,
             ${identity} AS identity, ${generated} AS generated,
             CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN
               CASE WHEN cn.nspname = 'pg_catalog' THEN quote_ident(co.collname) ELSE quote_ident(cn.nspname) || '.' || quote_ident(co.collname) END
             END AS collation
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
      LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`, [oid]),
    sql.unsafe(`
      SELECT con.conname AS name, con.contype AS type, ${keyColumns("con.conkey", "con.conrelid")} AS columns,
             CASE WHEN con.contype = 'c' THEN pg_catalog.pg_get_expr(con.conbin, con.conrelid, true) END AS expression,
             fn.nspname AS ref_schema, fc.relname AS ref_table, ${keyColumns("con.confkey", "con.confrelid")} AS ref_columns,
             con.confdeltype AS on_delete, con.confupdtype AS on_update
      FROM pg_catalog.pg_constraint con
      LEFT JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid
      LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE con.conrelid = $1 AND con.contype IN ('p', 'u', 'f', 'c') ${topLevelConstraint(version)}
      ORDER BY con.conname`, [oid]),
    sql.unsafe(foreignKeysQuery(version, "AND con.confrelid = $1"), [oid]),
    sql.unsafe(`
      SELECT ic.relname AS name, i.indisunique AS unique, i.indisprimary AS primary, am.amname AS method,
             pg_catalog.pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
             -- indkey and indoption are 0-based; a key part on no column (0) is an expression.
             (SELECT json_agg(json_build_object(
                'column', a.attname,
                'expression', CASE WHEN i.indkey[k.n - 1] = 0 THEN pg_catalog.pg_get_indexdef(i.indexrelid, k.n, true) END,
                'option', i.indoption[k.n - 1],
                'opclass', CASE WHEN NOT opc.opcdefault THEN opc.opcname END) ORDER BY k.n)
              FROM generate_series(1, ${keyAtts}) AS k(n)
              LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[k.n - 1] AND i.indkey[k.n - 1] <> 0
              LEFT JOIN pg_catalog.pg_opclass opc ON opc.oid = i.indclass[k.n - 1]) AS keys
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_catalog.pg_am am ON am.oid = ic.relam
      WHERE i.indrelid = $1
      ORDER BY ic.relname`, [oid]),
  ]);

  const pk = constraints.find((c) => c.type === "p");
  const uniques: DbUniqueConstraint[] = constraints.filter((c) => c.type === "u").map((c) => ({ name: c.name as string, columns: c.columns as string[] }));
  const checks: DbCheckConstraint[] = constraints.filter((c) => c.type === "c").map((c) => ({ name: c.name as string, expression: c.expression as string }));
  const foreignKeys = constraints.filter((c) => c.type === "f").map((c) => toForeignKey({ ...c, schema, table }));
  const primaryKey = pk ? { name: pk.name as string, columns: pk.columns as string[] } : null;
  const kind = ({ r: "table", p: "table", f: "foreign", v: "view", m: "matview" } as const)[rel.kind as "r"];

  return {
    schema,
    name: table,
    kind,
    columns: columns.map((c) => {
      // A generated column keeps its expression where a default would be.
      const defaultValue = c.generated ? null : (c.default_value as string | null);
      return {
        name: c.name as string,
        type: c.type as string,
        nullable: c.nullable === true,
        defaultValue,
        comment: (c.comment as string | null) ?? null,
        autoIncrement: c.identity === "a" || c.identity === "d" || /^nextval\(/i.test(defaultValue ?? ""),
        generated: !!c.generated,
        computedExpression: c.generated ? (c.default_value as string | null) : null,
        collation: (c.collation as string | null) ?? null,
        // 's' stored; Postgres 18 adds 'v', computed on read.
        ...(c.generated ? { computedStored: c.generated === "s" } : {}),
        identity: c.identity === "a" ? "always" : c.identity === "d" ? "default" : null,
      };
    }),
    primaryKey,
    foreignKeys,
    references: references.map(toForeignKey),
    indexes: indexes.map((i): DbIndex => {
      const keys = indexKeys(i.keys, i.method as string | null);
      return {
        name: i.name as string,
        columns: keys.map((k) => k.column ?? k.expression ?? ""),
        keys,
        unique: i.unique === true,
        primary: i.primary === true,
        where: (i.predicate as string | null) ?? null,
        method: (i.method as string | null) ?? null,
      };
    }),
    uniques,
    checks,
    comment: (rel.comment as string | null) ?? null,
    rowKey: primaryKey?.columns ?? [],
    rowKeyIsRowid: false,
  };
}
