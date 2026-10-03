/**
 * The CREATE statement of one Postgres object, for the SQL tab: built from `pg_catalog` for a
 * table (Postgres has no `SHOW CREATE TABLE`), and taken from the server's own `pg_get_*def` for
 * everything it can print itself — constraints, indexes, views, routines and triggers.
 *
 * The script has to run again on an empty database and give back the same structure. That is why
 * a column whose default draws on a sequence it owns is written `serial` rather than as the
 * `nextval('…_seq')` the catalog holds: that sequence does not exist yet where the script is run.
 *
 * `version` is `server_version_num`, as for the analyser: partitioning is 10+, `attidentity` 10+,
 * `pg_sequence` 10+, `conparentid` 11+, `attgenerated` 12+.
 */
import type postgres from "postgres";
import type { DbObjectRef } from "../../shared/db-structure.ts";
import { doubleQuoteIdent } from "./dialect.ts";

const q = doubleQuoteIdent;
const qualified = (schema: string, name: string) => `${q(schema)}.${q(name)}`;

/** Postgres' own literal of a text, so a backslash reads the same whatever `standard_conforming_strings` says. */
async function literal(sql: postgres.Sql, text: string): Promise<string> {
  const [row] = await sql`SELECT pg_catalog.quote_literal(${text}::text) AS v`;
  return String(row?.v);
}

/** `CREATE TABLE`'s serial pseudo-types, by the integer type they stand for. */
const SERIAL: Record<string, string> = { integer: "serial", bigint: "bigserial", smallint: "smallserial" };

/** Constraints in the order a person writes them: key, uniques, references, checks, exclusions. */
const CONSTRAINT_ORDER = "pufcx";

export async function pgObjectSql(sql: postgres.Sql, version: number, obj: DbObjectRef): Promise<string | null> {
  const schema = obj.schema ?? "public";
  switch (obj.kind) {
    case "table": return tableSql(sql, version, schema, obj.name);
    case "view":
    case "matview": return viewSql(sql, schema, obj.name, obj.kind);
    case "function":
    case "procedure": return routineSql(sql, version, schema, obj.name, obj.kind, obj.args);
    case "trigger": return triggerSql(sql, schema, obj.name, obj.table);
    case "sequence": return sequenceSql(sql, version, schema, obj.name);
  }
}

/** `COMMENT ON COLUMN` for every commented column of a relation. */
async function columnComments(sql: postgres.Sql, oid: number, target: string): Promise<string[]> {
  const rows = await sql.unsafe(`
    SELECT a.attname AS name, pg_catalog.quote_literal(pg_catalog.col_description(a.attrelid, a.attnum)) AS comment
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped AND pg_catalog.col_description(a.attrelid, a.attnum) IS NOT NULL
    ORDER BY a.attnum`, [oid]);
  return rows.map((r) => `COMMENT ON COLUMN ${target}.${q(r.name as string)} IS ${r.comment as string};`);
}

/** Indexes a relation has beside the ones backing its constraints — those are written with the constraint. */
async function indexStatements(sql: postgres.Sql, oid: number, attachedOnly: boolean): Promise<string[]> {
  const rows = await sql.unsafe(`
    SELECT pg_catalog.pg_get_indexdef(i.indexrelid) AS def
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = $1
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
                      WHERE con.conindid = i.indexrelid AND con.conrelid = i.indrelid AND con.contype IN ('p', 'u', 'x'))
      ${attachedOnly ? "AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits ih WHERE ih.inhrelid = i.indexrelid)" : ""}
    ORDER BY ic.relname`, [oid]);
  return rows.map((r) => `${r.def as string};`);
}

async function tableSql(sql: postgres.Sql, version: number, schema: string, name: string): Promise<string | null> {
  const partitions = version >= 100000;
  const [rel] = await sql.unsafe(`
    SELECT c.oid, c.relkind AS kind, c.relpersistence AS persistence, c.reloptions AS options,
           ${partitions ? "c.relispartition" : "false"} AS is_partition,
           ${partitions ? "pg_catalog.pg_get_expr(c.relpartbound, c.oid)" : "NULL"} AS bound,
           ${partitions ? "CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END" : "NULL"} AS partition_key,
           pg_catalog.quote_literal(pg_catalog.obj_description(c.oid, 'pg_class')) AS comment
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'f')`, [schema, name]);
  if (!rel) return null;
  const oid = rel.oid as number;
  const target = qualified(schema, name);

  const identity = version >= 100000 ? "a.attidentity" : "''";
  const generated = version >= 120000 ? "a.attgenerated" : "''";
  const topLevel = version >= 110000 ? "AND con.conparentid = 0" : "";
  const [parents, columns, constraints] = await Promise.all([
    sql.unsafe(`
      SELECT pn.nspname AS schema, pc.relname AS name
      FROM pg_catalog.pg_inherits ih
      JOIN pg_catalog.pg_class pc ON pc.oid = ih.inhparent
      JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace
      WHERE ih.inhrelid = $1 ORDER BY ih.inhseqno`, [oid]),
    sql.unsafe(`
      SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
             pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS expr, ${identity} AS identity, ${generated} AS generated,
             a.attislocal AS local,
             EXISTS (SELECT 1 FROM pg_catalog.pg_depend dep JOIN pg_catalog.pg_class s ON s.oid = dep.objid AND s.relkind = 'S'
                     WHERE dep.classid = 'pg_catalog.pg_class'::regclass AND dep.refclassid = 'pg_catalog.pg_class'::regclass
                       AND dep.refobjid = a.attrelid AND dep.refobjsubid = a.attnum AND dep.deptype = 'a') AS owns_sequence
      FROM pg_catalog.pg_attribute a
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`, [oid]),
    sql.unsafe(`
      SELECT con.conname AS name, con.contype AS type, con.conislocal AS local, pg_catalog.pg_get_constraintdef(con.oid, true) AS def
      FROM pg_catalog.pg_constraint con
      WHERE con.conrelid = $1 AND con.contype IN ('p', 'u', 'f', 'c', 'x') ${topLevel}
      ORDER BY con.conname`, [oid]),
  ]);
  const local = constraints
    .filter((c) => c.local === true)
    .sort((a, b) => CONSTRAINT_ORDER.indexOf(a.type as string) - CONSTRAINT_ORDER.indexOf(b.type as string));
  const constraintLine = (c: postgres.Row) => `CONSTRAINT ${q(c.name as string)} ${c.def as string}`;

  const out: string[] = [];
  if (rel.is_partition === true && parents[0]) {
    // A partition takes its columns and its parent's keys from the parent; only what it adds is its own.
    const parent = qualified(parents[0].schema as string, parents[0].name as string);
    out.push(`CREATE TABLE ${target} PARTITION OF ${parent}\n  ${rel.bound as string};`);
    for (const c of local) out.push(`ALTER TABLE ${target} ADD ${constraintLine(c)};`);
  } else {
    const lines: string[] = [];
    for (const c of columns) {
      // An inherited column comes with INHERITS.
      if (c.local === false) continue;
      lines.push(columnLine(c));
    }
    for (const c of local) lines.push(constraintLine(c));
    const unlogged = rel.persistence === "u" ? "UNLOGGED " : "";
    const foreign = rel.kind === "f" ? "FOREIGN " : "";
    let statement = `CREATE ${unlogged}${foreign}TABLE ${target} (\n${lines.map((l) => `  ${l}`).join(",\n")}\n)`;
    if (parents.length > 0) statement += `\nINHERITS (${parents.map((p) => qualified(p.schema as string, p.name as string)).join(", ")})`;
    if (rel.partition_key) statement += `\nPARTITION BY ${rel.partition_key as string}`;
    const options = (rel.options as string[] | null) ?? [];
    if (options.length > 0) statement += `\nWITH (${options.join(", ")})`;
    if (rel.kind === "f") statement += await foreignTableClause(sql, oid);
    out.push(`${statement};`);
  }

  out.push(...await indexStatements(sql, oid, rel.is_partition === true));
  if (rel.comment) out.push(`COMMENT ON ${rel.kind === "f" ? "FOREIGN TABLE" : "TABLE"} ${target} IS ${rel.comment as string};`);
  out.push(...await columnComments(sql, oid, target));
  return out.join("\n");
}

function columnLine(c: postgres.Row): string {
  const type = c.type as string;
  const expr = (c.expr as string | null) ?? null;
  const serial = c.owns_sequence === true && expr !== null && /^nextval\(/i.test(expr) ? SERIAL[type] : undefined;
  let line = `${q(c.name as string)} ${serial ?? type}`;
  if (c.not_null === true) line += " NOT NULL";
  if (c.identity === "a") line += " GENERATED ALWAYS AS IDENTITY";
  else if (c.identity === "d") line += " GENERATED BY DEFAULT AS IDENTITY";
  else if (c.generated && expr !== null) line += ` GENERATED ALWAYS AS (${expr}) ${c.generated === "v" ? "VIRTUAL" : "STORED"}`;
  else if (expr !== null && !serial) line += ` DEFAULT ${expr}`;
  return line;
}

/** `SERVER … OPTIONS (…)` of a foreign table. */
async function foreignTableClause(sql: postgres.Sql, oid: number): Promise<string> {
  const [row] = await sql.unsafe(`
    SELECT s.srvname AS server, ft.ftoptions AS options
    FROM pg_catalog.pg_foreign_table ft JOIN pg_catalog.pg_foreign_server s ON s.oid = ft.ftserver
    WHERE ft.ftrelid = $1`, [oid]);
  if (!row) return "";
  let clause = `\nSERVER ${q(row.server as string)}`;
  const options = (row.options as string[] | null) ?? [];
  if (options.length > 0) {
    const pairs = await Promise.all(options.map(async (o) => {
      const eq = o.indexOf("=");
      return `${q(o.slice(0, eq))} ${await literal(sql, o.slice(eq + 1))}`;
    }));
    clause += `\nOPTIONS (${pairs.join(", ")})`;
  }
  return clause;
}

async function viewSql(sql: postgres.Sql, schema: string, name: string, kind: "view" | "matview"): Promise<string | null> {
  const [rel] = await sql.unsafe(`
    SELECT c.oid, pg_catalog.pg_get_viewdef(c.oid, true) AS def, c.reloptions AS options,
           pg_catalog.quote_literal(pg_catalog.obj_description(c.oid, 'pg_class')) AS comment
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = $3`, [schema, name, kind === "view" ? "v" : "m"]);
  if (!rel) return null;
  const oid = rel.oid as number;
  const target = qualified(schema, name);
  const body = String(rel.def).trim().replace(/;$/, "");
  const options = (rel.options as string[] | null) ?? [];
  const withClause = options.length > 0 ? ` WITH (${options.join(", ")})` : "";
  const out = [kind === "view"
    ? `CREATE OR REPLACE VIEW ${target}${withClause} AS\n${body};`
    : `CREATE MATERIALIZED VIEW ${target}${withClause} AS\n${body};`];
  if (kind === "matview") out.push(...await indexStatements(sql, oid, false));
  if (rel.comment) out.push(`COMMENT ON ${kind === "view" ? "VIEW" : "MATERIALIZED VIEW"} ${target} IS ${rel.comment as string};`);
  out.push(...await columnComments(sql, oid, target));
  return out.join("\n");
}

async function routineSql(
  sql: postgres.Sql, version: number, schema: string, name: string, kind: "function" | "procedure", args: string | undefined,
): Promise<string | null> {
  const kindFilter = version >= 110000 ? `AND p.prokind = '${kind === "procedure" ? "p" : "f"}'` : "";
  const rows = await sql.unsafe(`
    SELECT p.oid, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
           pg_catalog.quote_literal(pg_catalog.obj_description(p.oid, 'pg_proc')) AS comment
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1 AND p.proname = $2 ${kindFilter}
    ORDER BY 2`, [schema, name]);
  // Overloads share a name; the argument list the tree carries says which one.
  const routine = args === undefined ? rows[0] : rows.find((r) => r.args === args);
  if (!routine) return null;
  const [def] = await sql.unsafe(`SELECT pg_catalog.pg_get_functiondef($1) AS def`, [routine.oid]);
  const out = [`${String(def?.def).trimEnd()};`];
  if (routine.comment) {
    out.push(`COMMENT ON ${kind === "procedure" ? "PROCEDURE" : "FUNCTION"} ${qualified(schema, name)}(${routine.args as string}) IS ${routine.comment as string};`);
  }
  return out.join("\n");
}

async function triggerSql(sql: postgres.Sql, schema: string, name: string, table: string | undefined): Promise<string | null> {
  const [row] = await sql.unsafe(`
    SELECT pg_catalog.pg_get_triggerdef(t.oid, true) AS def, c.relname AS table,
           pg_catalog.quote_literal(pg_catalog.obj_description(t.oid, 'pg_trigger')) AS comment
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal ${table === undefined ? "" : "AND c.relname = $3"}
    ORDER BY c.relname LIMIT 1`, table === undefined ? [schema, name] : [schema, name, table]);
  if (!row) return null;
  const out = [`${row.def as string};`];
  if (row.comment) out.push(`COMMENT ON TRIGGER ${q(name)} ON ${qualified(schema, row.table as string)} IS ${row.comment as string};`);
  return out.join("\n");
}

async function sequenceSql(sql: postgres.Sql, version: number, schema: string, name: string): Promise<string | null> {
  const [rel] = await sql.unsafe(`
    SELECT c.oid, pg_catalog.quote_literal(pg_catalog.obj_description(c.oid, 'pg_class')) AS comment
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'S'`, [schema, name]);
  if (!rel) return null;
  const target = qualified(schema, name);
  // Before 10 a sequence's settings are only in the sequence itself.
  const [s] = version >= 100000
    ? await sql.unsafe(`
        SELECT pg_catalog.format_type(seqtypid, NULL) AS type, seqstart AS start, seqincrement AS increment,
               seqmin AS min, seqmax AS max, seqcache AS cache, seqcycle AS cycle
        FROM pg_catalog.pg_sequence WHERE seqrelid = $1`, [rel.oid])
    : await sql.unsafe(`
        SELECT NULL AS type, start_value AS start, increment_by AS increment, min_value AS min, max_value AS max,
               cache_value AS cache, is_cycled AS cycle
        FROM ${target}`);
  if (!s) return null;
  const lines = [
    ...(s.type ? [`AS ${s.type as string}`] : []),
    `INCREMENT BY ${String(s.increment)}`,
    `MINVALUE ${String(s.min)}`,
    `MAXVALUE ${String(s.max)}`,
    `START WITH ${String(s.start)}`,
    `CACHE ${String(s.cache)}`,
    ...(s.cycle === true ? ["CYCLE"] : []),
  ];
  const out = [`CREATE SEQUENCE ${target}\n${lines.map((l) => `  ${l}`).join("\n")};`];
  if (rel.comment) out.push(`COMMENT ON SEQUENCE ${target} IS ${rel.comment as string};`);
  return out.join("\n");
}
