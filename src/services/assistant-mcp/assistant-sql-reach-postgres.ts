import { splitSqlStatements, sqlCode } from "../../shared/split-sql-statements.ts";
import { deparsedPostgresSafety, type SqlSafety } from "./assistant-sql-safety.ts";
import { hexJson, mentionsName, operatorUses, rowUse, usesOperator, type OperatorUse } from "./assistant-sql-reach-names.ts";

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
 *  - domains with CHECK constraints, the user functions named like any word of the query
 *    (called, or used column-style on a row), and the user operators with their operand types;
 *  - the types whose values run code from outside the system schemas: a type whose input or
 *    output functions live outside them (an extension's base type, such as citext), one with a
 *    cast through a function that is not pure, and every domain, array and range over those —
 *    with the reached relations' columns of those types, and of any type an operator below takes.
 * Each text then goes through the same check as the query. "Pure" below means an IMMUTABLE
 * function, not an aggregate, in a system schema: Postgres's own built-ins and nothing else.
 * A function outside them is not pure whatever its language or whoever installed it. That
 * includes an extension's: being put in place by an administrator says nothing about what the
 * code does, and C functions — most of an extension — run unchecked inside the server. So
 * citext's `max(citext)`, an aggregate whose transition function is a C function of the
 * extension, shadows the safe-listed `max`, and a query writing `max(…)` on a database with
 * citext is asked about. An aggregate is never pure even in a system schema, because its own
 * row says internal and IMMUTABLE whatever its transition function runs; none of the uses below
 * can name one anyway (an operator or a cast names a plain function).
 *
 * A user operator matters only where the query can make Postgres choose it, and Postgres chooses
 * an operator by its operand types. So one whose operands are user types (citext's `=`) is
 * reached only by a value of such a type — a column of it the query reads, the type's name
 * written in the query (`::citext`, `CAST(… AS citext)`, `citext 'x'`) — or by a literal of no
 * type yet, which loses to `pg_catalog`'s `text` version when there is one. A call cannot make
 * one: every function the query may call is a pure `pg_catalog` one (anything else was asked
 * about already), and those return built-in types. An operator any built-in type can reach —
 * one taking a built-in or polymorphic type, a domain over one, or a type with an implicit cast
 * from one — is asked about wherever its symbol is used, as before: measured on Postgres 15, a
 * user `=` on a type with implicit casts from `text` and `bytea` ran for `'a'::text =
 * '\x00'::bytea`, which no built-in `=` takes. Reading a column of a type whose output runs
 * extension code (citext) asks by itself; reading the int and text columns of the same table
 * does not.
 */

export interface PostgresReach {
  views: [schema: string, name: string, definition: string][];
  policies: [table: string, policy: string, condition: string][];
  generated: [table: string, column: string, expression: string][];
  domains: [name: string, checks: string[]][];
  /**
   * Functions outside the system schemas — extensions' included — named like one of the query's words. Not
   * only those it calls as `name(…)`: Postgres also runs a one-argument function written as a
   * column of a row — `t.f` or `(t).f` calls `f(t)` when `t` has no column `f` — with no
   * parenthesis anywhere for the text check to see.
   */
  shadowed: string[];
  /**
   * Types that matter: `why` says what reading or naming a value of the type runs — `io`, input
   * and output functions outside the system schemas; `cast`, a cast through a function that is
   * not pure — and is empty for a type that matters only as an operand of a user operator.
   */
  types: [oid: string, name: string, display: string, why: string][];
  /** The reached relations' columns of those types, and of composite types outside the system schemas (`composite`). */
  columns: [relation: string, column: string, type: string, composite: boolean][];
  operators: PostgresUserOperator[];
}

/**
 * A user operator's operand: absent, `any` when a built-in type can reach it, or the types that
 * can (by oid).
 */
export type OperandTypes = null | "any" | string[];

/** An operator outside the system schemas whose function is not pure. */
export interface PostgresUserOperator {
  name: string;
  left: OperandTypes;
  right: OperandTypes;
  /** `pg_catalog` has the same operator for `text`, which untyped literals on every side resolve to instead. */
  shielded: boolean;
  /** In a default btree or hash operator class: ORDER BY, GROUP BY, DISTINCT and the like run it with no symbol written. */
  implicit: boolean;
}

/** The catalog query for a query whose words are `names`; the last statement answers one row, one text column of JSON. */
export function postgresReachSql(names: readonly string[]): string {
  return `SELECT pg_catalog.set_config('search_path', 'pg_catalog', true), pg_catalog.set_config('statement_timeout', '5000', true);
WITH RECURSIVE
names AS (SELECT json_array_elements_text(convert_from(decode('${hexJson(names)}', 'hex'), 'UTF8')::json) AS name),
sys AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname IN ('pg_catalog', 'information_schema')),
pure AS (
  SELECT p.oid FROM pg_catalog.pg_proc p
  WHERE p.provolatile = 'i' AND p.pronamespace IN (SELECT oid FROM sys)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_aggregate a WHERE a.aggfnoid = p.oid)
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
),
read_roots(oid, why) AS (
  SELECT t.oid, 'io' FROM pg_catalog.pg_type t
  WHERE t.typnamespace NOT IN (SELECT oid FROM sys) AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid IN (t.typinput::oid, t.typoutput::oid, t.typreceive::oid, t.typsend::oid) AND p.pronamespace NOT IN (SELECT oid FROM sys))
  UNION ALL
  SELECT r.rngtypid, 'io' FROM pg_catalog.pg_range r
  WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid IN (r.rngcanonical::oid, r.rngsubdiff::oid) AND p.pronamespace NOT IN (SELECT oid FROM sys))
  UNION ALL
  SELECT oid, 'cast' FROM cast_types
),
user_ops AS (
  SELECT o.oid, o.oprname, o.oprkind, o.oprleft, o.oprright FROM pg_catalog.pg_operator o
  WHERE o.oprnamespace NOT IN (SELECT oid FROM sys) AND o.oprcode::oid NOT IN (SELECT oid FROM pure)
),
sides(op, pos, oid) AS (
  SELECT oid, 'l'::text, oprleft FROM user_ops WHERE oprleft <> 0
  UNION ALL
  SELECT oid, 'r'::text, oprright FROM user_ops WHERE oprright <> 0
),
side_up(op, pos, oid) AS (
  SELECT op, pos, oid FROM sides
  UNION
  SELECT u.op, u.pos, t.typbasetype FROM side_up u JOIN pg_catalog.pg_type t ON t.oid = u.oid WHERE t.typtype = 'd'
),
side_src(op, pos, oid) AS (
  SELECT op, pos, oid FROM side_up
  UNION
  SELECT u.op, u.pos, k.castsource FROM side_up u JOIN pg_catalog.pg_cast k ON k.casttarget = u.oid AND k.castcontext = 'i'
),
side_any AS (
  SELECT DISTINCT s.op, s.pos FROM side_src s JOIN pg_catalog.pg_type t ON t.oid = s.oid
  WHERE t.typnamespace IN (SELECT oid FROM sys) OR t.typtype = 'p'
),
wraps(inner_type, outer_type) AS (
  SELECT typbasetype, oid FROM pg_catalog.pg_type WHERE typtype = 'd'
  UNION ALL
  SELECT typelem, oid FROM pg_catalog.pg_type WHERE typcategory = 'A' AND typelem <> 0
  UNION ALL
  SELECT rngsubtype, rngtypid FROM pg_catalog.pg_range
  UNION ALL
  SELECT rngtypid, (to_jsonb(r.*) ->> 'rngmultitypid')::oid FROM pg_catalog.pg_range r WHERE (to_jsonb(r.*) ->> 'rngmultitypid') IS NOT NULL
),
down(root, oid) AS (
  SELECT oid, oid FROM read_roots
  UNION
  SELECT s.oid, s.oid FROM side_src s WHERE (s.op, s.pos) NOT IN (SELECT op, pos FROM side_any)
  UNION
  SELECT d.root, w.outer_type FROM down d JOIN wraps w ON w.inner_type = d.oid
),
-- Joined once rather than looked up per operator: a correlated subquery over these recursive
-- CTEs re-ran them for every operator, 1.3 s against 50 ms on a database with citext.
operand_types(op, pos, side) AS (
  SELECT op, pos, to_json('any'::text) FROM side_any
  UNION ALL
  SELECT s.op, s.pos, json_agg(DISTINCT d.oid::text) FROM side_src s JOIN down d ON d.root = s.oid
  WHERE (s.op, s.pos) NOT IN (SELECT op, pos FROM side_any) GROUP BY s.op, s.pos
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
    WHERE p.proname IN (SELECT name FROM names) AND p.pronamespace NOT IN (SELECT oid FROM sys)),
  'types', (SELECT json_agg(json_build_array(x.oid::text, t.typname, pg_catalog.format_type(x.oid, NULL), x.why))
    FROM (SELECT d.oid, COALESCE(max(rr.why), '') AS why FROM down d LEFT JOIN read_roots rr ON rr.oid = d.root GROUP BY d.oid) x
    JOIN pg_catalog.pg_type t ON t.oid = x.oid),
  'columns', (SELECT json_agg(json_build_array(c.relname, a.attname, a.atttypid::text, t.typtype = 'c'))
    FROM reached r JOIN pg_catalog.pg_class c ON c.oid = r.oid
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    WHERE a.atttypid IN (SELECT oid FROM down) OR (t.typtype = 'c' AND t.typnamespace NOT IN (SELECT oid FROM sys))),
  'operators', (SELECT json_agg(json_build_array(o.oprname, o.oprkind::text, l.side, r.side,
      EXISTS (SELECT 1 FROM pg_catalog.pg_operator s
        WHERE s.oprname = o.oprname AND s.oprkind = o.oprkind AND s.oprnamespace IN (SELECT oid FROM sys)
          AND s.oprright = 'pg_catalog.text'::pg_catalog.regtype AND (o.oprkind <> 'b' OR s.oprleft = 'pg_catalog.text'::pg_catalog.regtype)),
      EXISTS (SELECT 1 FROM pg_catalog.pg_amop am
        JOIN pg_catalog.pg_opclass oc ON oc.opcfamily = am.amopfamily AND oc.opcdefault
        JOIN pg_catalog.pg_am m ON m.oid = am.amopmethod
        WHERE am.amopopr = o.oid AND m.amname IN ('btree', 'hash'))))
    FROM user_ops o
    LEFT JOIN operand_types l ON l.op = o.oid AND l.pos = 'l'
    LEFT JOIN operand_types r ON r.op = o.oid AND r.pos = 'r')
)::text AS reach`;
}

const isTuple = (v: unknown, n: number): v is string[] =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === "string");
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isOperand = (v: unknown): v is OperandTypes => v === null || v === "any" || strings(v);
const isOperator = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 6 && typeof v[0] === "string" && typeof v[1] === "string"
  && isOperand(v[2]) && isOperand(v[3]) && typeof v[4] === "boolean" && typeof v[5] === "boolean";

/** The catalog query's answer, checked field by field; anything off throws. */
export function parsePostgresReach(text: unknown): PostgresReach {
  if (typeof text !== "string") throw new Error("the catalog answered no text");
  const raw = JSON.parse(text) as Record<string, unknown>;
  const list = (key: string, ok: (v: unknown) => boolean): unknown[] => {
    if (!(key in raw)) throw new Error(`the catalog's answer has no ${key}`);
    const value = raw[key] ?? [];
    if (!Array.isArray(value) || !value.every(ok)) throw new Error(`the catalog's ${key} were not in the expected shape`);
    return value;
  };
  const operators = list("operators", isOperator) as [string, string, OperandTypes, OperandTypes, boolean, boolean][];
  return {
    views: list("views", (v) => isTuple(v, 3)) as PostgresReach["views"],
    policies: list("policies", (v) => isTuple(v, 3)) as PostgresReach["policies"],
    generated: list("generated", (v) => isTuple(v, 3)) as PostgresReach["generated"],
    domains: list("domains", (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && strings(v[1])) as PostgresReach["domains"],
    shadowed: list("shadowed", (v) => typeof v === "string") as string[],
    types: list("types", (v) => isTuple(v, 4)) as PostgresReach["types"],
    columns: list("columns", (v) => Array.isArray(v) && v.length === 4 && isTuple(v.slice(0, 3), 3) && typeof v[3] === "boolean") as PostgresReach["columns"],
    operators: operators.map(([name, , left, right, shielded, implicit]) => ({ name, left, right, shielded, implicit })),
  };
}

const after = (verdict: SqlSafety & { proven: false }): string => verdict.reason.replace(/^it /, "");

/** `pg_catalog.name`, bare or quoted: a name pinned to the system schema, which no user function answers to. */
const PG_CATALOG_QUALIFIED = /(?<![\w$"])(?:pg_catalog|"pg_catalog")\s*\.\s*(?:[A-Za-z_][\w$]*|"(?:[^"]|"")*")/gi;

const WHY: Readonly<Record<string, string>> = {
  io: "whose input and output functions are outside pg_catalog",
  cast: "which has a cast that runs a user function",
};

/**
 * The types `texts` (the query, then the deparsed texts it reaches) may handle a value of, by
 * oid: those of the reached columns they may read — named, or read with every column of their
 * relation — and those whose name they write. A reason instead when one of them runs code from
 * outside pg_catalog just by being read or named.
 */
function typesHandled(texts: readonly string[], reach: PostgresReach): { used: Set<string> } | { reason: string } {
  const types = new Map(reach.types.map((t) => [t[0], t]));
  const relations = new Set(reach.columns.map((c) => c[0]));
  let all = false;
  const whole = new Set<string>();
  for (const code of texts.flatMap((t) => splitSqlStatements(t, "postgres").map((s) => sqlCode(s, "postgres")))) {
    const use = rowUse(code, relations);
    all ||= use.all;
    for (const relation of use.whole) whole.add(relation);
  }
  const used = new Set<string>();
  for (const [relation, column, oid, composite] of reach.columns) {
    if (!all && !whole.has(relation) && !mentionsName(texts, column)) continue;
    if (composite) return { reason: `it reads ${relation}.${column}, of a composite type PPM does not look inside` };
    const type = types.get(oid);
    if (!type) return { reason: `it reads ${relation}.${column}, whose type the catalog did not describe` };
    if (type[3]) return { reason: `it reads ${relation}.${column}, of type ${type[2]}, ${WHY[type[3]] ?? WHY.io}` };
    used.add(oid);
  }
  for (const [oid, name, display, why] of reach.types) {
    if (!mentionsName(texts, name)) continue;
    if (why) return { reason: `it names the type ${display}, ${WHY[why] ?? WHY.io}` };
    used.add(oid);
  }
  return { used };
}

/** Why the query may run the user operator `op`, given the operator uses in its text and the types it handles; null when it cannot. */
function operatorReason(op: PostgresUserOperator, uses: readonly OperatorUse[], used: ReadonlySet<string>, display: (oid: string) => string): string | null {
  const sides = [op.left, op.right].filter((s): s is "any" | string[] => s !== null);
  const typed = sides.flatMap((s) => (s === "any" ? [] : s)).find((oid) => used.has(oid));
  const anySide = sides.includes("any");
  if (op.implicit && (typed || anySide)) {
    return typed
      ? `it may sort or compare ${display(typed)} values, which runs the operator ${op.name} defined outside pg_catalog`
      : `this database sorts or compares a built-in type with the operator ${op.name}, defined outside pg_catalog`;
  }
  for (const use of uses) {
    if (!usesOperator(use, op.name)) continue;
    if (typed) return `it may use the operator ${op.name} on ${display(typed)}, which this database defines outside pg_catalog`;
    const leftOk = op.left === null || op.left === "any" || use.leftLiteral;
    const rightOk = op.right === null || op.right === "any" || use.rightLiteral;
    if (!leftOk || !rightOk) continue;
    // Untyped literals on every side resolve to pg_catalog's text operator when there is one.
    if (!anySide && op.shielded) continue;
    return `it uses the operator ${op.name}, which this database also defines outside pg_catalog`;
  }
  return null;
}

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
  const handled = typesHandled(texts, reach);
  if ("reason" in handled) return { proven: false, reason: handled.reason };

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
    // The operators of a view, a policy or a generated column were resolved when it was created
    // and come back schema-qualified, so only the query's own text resolves one by name now.
    const uses = splitSqlStatements(sql, "postgres").flatMap((s) => operatorUses(sqlCode(s, "postgres")));
    const names = new Map(reach.types.map((t) => [t[0], t[2]]));
    const display = (oid: string): string => names.get(oid) ?? "a value";
    for (const op of reach.operators) {
      const reason = operatorReason(op, uses, handled.used, display);
      if (reason) return { proven: false, reason };
    }
  }
  return { proven: true };
}
