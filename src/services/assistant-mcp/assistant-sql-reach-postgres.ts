import { splitSqlStatements, sqlCode } from "../../shared/split-sql-statements.ts";
import { deparsedPostgresSafety, type SqlSafety } from "./assistant-sql-safety.ts";
import { hexJson, mentionsName, operatorRuns } from "./assistant-sql-reach-names.ts";

/**
 * What a Postgres query reaches beyond its own text, read from the catalog without planning or
 * running the query.
 *
 * Why not `EXPLAIN (VERBOSE)`: planning runs code. Measured on Postgres 15, `EXPLAIN` of a view
 * filtering on a STABLE plpgsql function ran it (selectivity estimation folds STABLE calls), and
 * an IMMUTABLE one with constant arguments was folded away — run, and gone from the plan. Its
 * output also prints a user function bare whenever the search path finds it (`public.lower(varchar)`
 * printed as `lower(name)`), and leaves out a Values Scan's rows and a LIMIT's expression, so a
 * plan cannot show what a query calls even when reading it is harmless.
 *
 * Instead one read-only catalog query (search path pinned to `pg_catalog`, 5 s timeout):
 *  - every relation the query's words could name, and through `pg_depend` every relation a view
 *    or a row-level security policy among them reads, plus inheritance children, outside the
 *    system schemas (whose views PPM trusts: only a superuser can put anything there);
 *  - for those: each view's definition, each SELECT policy's condition, each virtual generated
 *    column's expression — deparsed under that pinned path, so a bare call in them is exactly a
 *    `pg_catalog` function and anything else comes out schema-qualified or as `OPERATOR(…)`;
 *  - domains with CHECK constraints, user casts through a function, the user functions named
 *    like any word of the query (called, or used column-style on a row), and the user operators.
 * Each text then goes through the same check as the query. "Pure" below means an IMMUTABLE
 * function that is C/internal (only a superuser installs one), in a system schema, or part of an
 * extension (whose script the server's administrator put in place) — citext's `max(citext)`, say.
 * An aggregate's own row says internal and IMMUTABLE whatever its transition function runs, so
 * an aggregate is pure only when every function it runs is.
 */

export interface PostgresReach {
  views: [schema: string, name: string, definition: string][];
  policies: [table: string, policy: string, condition: string][];
  generated: [table: string, column: string, expression: string][];
  domains: [name: string, checks: string[]][];
  /**
   * Functions outside the system schemas, not pure, named like one of the query's words. Not
   * only those it calls as `name(…)`: Postgres also runs a one-argument function written as a
   * column of a row — `t.f` or `(t).f` calls `f(t)` when `t` has no column `f` — with no
   * parenthesis anywhere for the text check to see.
   */
  shadowed: string[];
  /** Operators outside the system schemas whose function is not pure. */
  operators: string[];
  /** User-side types of casts through a function that is not pure. */
  castTypes: string[];
  /** Whether a reached relation has a column of one of those types (an implicit cast names no type). */
  castColumns: boolean;
}

/** The catalog query for a query whose words are `names`; the last statement answers one row, one text column of JSON. */
export function postgresReachSql(names: readonly string[]): string {
  return `SELECT pg_catalog.set_config('search_path', 'pg_catalog', true), pg_catalog.set_config('statement_timeout', '5000', true);
WITH RECURSIVE
names AS (SELECT json_array_elements_text(convert_from(decode('${hexJson(names)}', 'hex'), 'UTF8')::json) AS name),
sys AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname IN ('pg_catalog', 'information_schema')),
pure_fn AS (
  SELECT p.oid FROM pg_catalog.pg_proc p
  WHERE p.provolatile = 'i'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_aggregate a WHERE a.aggfnoid = p.oid)
    AND (p.prolang IN (SELECT oid FROM pg_catalog.pg_language WHERE lanname IN ('c', 'internal'))
      OR p.pronamespace IN (SELECT oid FROM sys)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'))
),
pure AS (
  SELECT oid FROM pure_fn
  UNION ALL
  SELECT a.aggfnoid::oid FROM pg_catalog.pg_aggregate a
  LEFT JOIN pg_catalog.pg_operator o ON o.oid = a.aggsortop
  WHERE ARRAY[a.aggtransfn, a.aggfinalfn, a.aggcombinefn, a.aggserialfn, a.aggdeserialfn,
      a.aggmtransfn, a.aggminvtransfn, a.aggmfinalfn, COALESCE(o.oprcode, 0)]::oid[]
    <@ (SELECT array_agg(oid) || 0::oid FROM pure_fn)
),
reached(oid) AS (
  SELECT c.oid FROM pg_catalog.pg_class c
  WHERE c.relname IN (SELECT name FROM names) AND c.relnamespace NOT IN (SELECT oid FROM sys)
  UNION
  SELECT c.oid FROM reached r
  CROSS JOIN LATERAL (
    SELECT d.refobjid AS oid FROM pg_catalog.pg_rewrite w
    JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.objid = w.oid AND d.refclassid = 'pg_catalog.pg_class'::regclass
    WHERE w.ev_class = r.oid AND EXISTS (SELECT 1 FROM pg_catalog.pg_class v WHERE v.oid = r.oid AND v.relkind = 'v')
    UNION ALL
    SELECT d.refobjid FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_policy'::regclass AND d.objid = p.oid AND d.refclassid = 'pg_catalog.pg_class'::regclass
    WHERE p.polrelid = r.oid
    UNION ALL
    SELECT i.inhrelid FROM pg_catalog.pg_inherits i WHERE i.inhparent = r.oid
  ) n
  JOIN pg_catalog.pg_class c ON c.oid = n.oid
  WHERE c.relnamespace NOT IN (SELECT oid FROM sys)
),
cast_types AS (
  SELECT t.oid, t.typname FROM pg_catalog.pg_cast k
  JOIN pg_catalog.pg_type t ON t.oid IN (k.castsource, k.casttarget)
  WHERE k.castfunc <> 0 AND k.castfunc NOT IN (SELECT oid FROM pure) AND t.typnamespace NOT IN (SELECT oid FROM sys)
)
SELECT json_build_object(
  'views', (SELECT json_agg(json_build_array(s.nspname, c.relname, pg_get_viewdef(c.oid)))
    FROM reached r JOIN pg_catalog.pg_class c ON c.oid = r.oid JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
    WHERE c.relkind = 'v'),
  'policies', (SELECT json_agg(json_build_array(c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid)))
    FROM reached r JOIN pg_catalog.pg_class c ON c.oid = r.oid JOIN pg_catalog.pg_policy p ON p.polrelid = c.oid
    WHERE c.relrowsecurity AND p.polqual IS NOT NULL AND p.polcmd IN ('r', '*')),
  'generated', (SELECT json_agg(json_build_array(c.relname, a.attname, pg_get_expr(ad.adbin, ad.adrelid)))
    FROM reached r JOIN pg_catalog.pg_class c ON c.oid = r.oid
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE (to_jsonb(a.*) ->> 'attgenerated') = 'v'),
  'domains', (SELECT json_agg(json_build_array(t.typname, x.checks))
    FROM pg_catalog.pg_type t
    CROSS JOIN LATERAL (
      WITH RECURSIVE chain(oid) AS (
        SELECT t.oid
        UNION
        SELECT b.typbasetype FROM chain JOIN pg_catalog.pg_type b ON b.oid = chain.oid WHERE b.typtype = 'd'
      )
      SELECT json_agg(pg_get_expr(k.conbin, 0)) AS checks
      FROM chain JOIN pg_catalog.pg_constraint k ON k.contypid = chain.oid
      WHERE k.contype = 'c' AND k.connamespace NOT IN (SELECT oid FROM sys)
    ) x
    WHERE t.typtype = 'd' AND t.typnamespace NOT IN (SELECT oid FROM sys) AND x.checks IS NOT NULL),
  'shadowed', (SELECT json_agg(DISTINCT p.proname) FROM pg_catalog.pg_proc p
    WHERE p.proname IN (SELECT name FROM names) AND p.pronamespace NOT IN (SELECT oid FROM sys) AND p.oid NOT IN (SELECT oid FROM pure)),
  'operators', (SELECT json_agg(DISTINCT o.oprname) FROM pg_catalog.pg_operator o
    WHERE o.oprnamespace NOT IN (SELECT oid FROM sys) AND o.oprcode::oid NOT IN (SELECT oid FROM pure)),
  'castTypes', (SELECT json_agg(DISTINCT typname) FROM cast_types),
  'castColumns', EXISTS (SELECT 1 FROM reached r JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid
    WHERE a.attnum > 0 AND NOT a.attisdropped AND a.atttypid IN (SELECT oid FROM cast_types))
)::text AS reach`;
}

const isTuple = (v: unknown, n: number): v is string[] =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === "string");
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The catalog query's answer, checked field by field; anything off throws. */
export function parsePostgresReach(text: unknown): PostgresReach {
  if (typeof text !== "string") throw new Error("the catalog answered no text");
  const raw = JSON.parse(text) as Record<string, unknown>;
  const list = (key: string, ok: (v: unknown) => boolean): unknown[] => {
    const value = raw[key] ?? [];
    if (!Array.isArray(value) || !value.every(ok)) throw new Error(`the catalog's ${key} were not in the expected shape`);
    return value;
  };
  const castColumns = raw.castColumns;
  if (typeof castColumns !== "boolean") throw new Error("the catalog's castColumns was not a boolean");
  return {
    views: list("views", (v) => isTuple(v, 3)) as PostgresReach["views"],
    policies: list("policies", (v) => isTuple(v, 3)) as PostgresReach["policies"],
    generated: list("generated", (v) => isTuple(v, 3)) as PostgresReach["generated"],
    domains: list("domains", (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && strings(v[1])) as PostgresReach["domains"],
    shadowed: list("shadowed", (v) => typeof v === "string") as string[],
    operators: list("operators", (v) => typeof v === "string") as string[],
    castTypes: list("castTypes", (v) => typeof v === "string") as string[],
    castColumns,
  };
}

const after = (verdict: SqlSafety & { proven: false }): string => verdict.reason.replace(/^it /, "");

/** `pg_catalog.name`, bare or quoted: a name pinned to the system schema, which no user function answers to. */
const PG_CATALOG_QUALIFIED = /(?<![\w$"])(?:pg_catalog|"pg_catalog")\s*\.\s*(?:[A-Za-z_][\w$]*|"(?:[^"]|"")*")/gi;

/**
 * Whether `sql` — already proven by its own text, calling the safe-listed functions `called` —
 * stays proven given what the catalog says it reaches; when not, why.
 */
export function postgresReachVerdict(sql: string, called: ReadonlySet<string>, reach: PostgresReach): SqlSafety {
  for (const [schema, name, definition] of reach.views) {
    const verdict = deparsedPostgresSafety(definition);
    if (!verdict.proven) return { proven: false, reason: `it reads the view ${schema}.${name}, whose definition ${after(verdict)}` };
  }
  for (const [table, policy, condition] of reach.policies) {
    const verdict = deparsedPostgresSafety(`SELECT ${condition}`);
    if (!verdict.proven) return { proven: false, reason: `it reads ${table}, whose row-level security policy ${policy} ${after(verdict)}` };
  }
  for (const [table, column, expression] of reach.generated) {
    const verdict = deparsedPostgresSafety(`SELECT ${expression}`);
    if (!verdict.proven) return { proven: false, reason: `it reads ${table}, whose generated column ${column} ${after(verdict)}` };
  }

  const texts = [sql, ...reach.views.map((v) => v[2]), ...reach.policies.map((p) => p[2]), ...reach.generated.map((g) => g[2])];
  for (const [domain, checks] of reach.domains) {
    if (!mentionsName(texts, domain)) continue;
    for (const check of checks) {
      const verdict = deparsedPostgresSafety(`SELECT ${check}`);
      if (!verdict.proven) return { proven: false, reason: `it may convert a value to the domain ${domain}, whose check ${after(verdict)}` };
    }
  }
  if (reach.castColumns) return { proven: false, reason: "it reads a column whose type has a cast that runs a user function" };
  const cast = reach.castTypes.find((type) => mentionsName(texts, type));
  if (cast) return { proven: false, reason: `it may convert a ${cast} value with a cast that runs a user function` };

  // The query's own text runs under the session's search path, where a user function or operator
  // can win over the built-in it is named like (a closer argument type is enough), and where a
  // name written as a row's column can be a call. Only a name pinned to pg_catalog reaches
  // nothing else.
  const unpinned = sql.replace(PG_CATALOG_QUALIFIED, " ");
  const shadow = reach.shadowed.find((name) => mentionsName([unpinned], name));
  if (shadow) {
    return {
      proven: false,
      reason: called.has(shadow.toLowerCase())
        ? `it calls ${shadow}(), and this database also has a function named ${shadow} outside pg_catalog that the call could reach`
        : `it names ${shadow}, and this database has a function of that name outside pg_catalog, which Postgres runs for a row written as t.${shadow}`,
    };
  }
  if (reach.operators.length) {
    const runs = splitSqlStatements(sql, "postgres").flatMap((s) => operatorRuns(sqlCode(s, "postgres")));
    const operator = reach.operators.find((op) => runs.some((run) => run.includes(op)));
    if (operator) return { proven: false, reason: `it uses the operator ${operator}, which this database also defines outside pg_catalog` };
  }
  return { proven: true };
}
