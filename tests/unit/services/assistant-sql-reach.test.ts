/**
 * A query's text can pass the safe-list check and still reach a side effect: through a view, a
 * row-level security policy, a domain's check, a user function named like a built-in, a user
 * operator, or a type whose code lives in an extension. The catalog check asks the database
 * what the query reaches; anything it cannot answer with certainty is "not proven", so the user
 * is asked rather than the query run.
 */
import { describe, expect, it } from "bun:test";
import { clipUtf8, mentionsName, nameCandidates, operatorUses, rowUse, usesOperator } from "../../../src/services/assistant-mcp/assistant-sql-reach-names.ts";
import { parsePostgresReach, postgresReachSql, postgresReachVerdict, type PostgresReach } from "../../../src/services/assistant-mcp/assistant-sql-reach-postgres.ts";
import { mysqlReachSql, mysqlReachVerdict } from "../../../src/services/assistant-mcp/assistant-sql-reach-mysql.ts";
import { assistantSqlReachSafety, type CatalogReader } from "../../../src/services/assistant-mcp/assistant-sql-reach-check.ts";
import { assistantSqlSafety } from "../../../src/services/assistant-mcp/assistant-sql-safety.ts";
import { splitSqlStatements, sqlCode } from "../../../src/shared/split-sql-statements.ts";
import { isReadOnlyQuery } from "../../../src/services/database/readonly-check.ts";

/**
 * The catalog query's answer on Postgres 15 for `SELECT count(*), lower(name), max(id) FROM v5,
 * v6, v7, plain, t, u, v_ci, v_id`, where citext is installed in `public` and:
 *  - `t (id int, name varchar(20), name_ci citext, m mood)`, `u (id int, e email, tags citext[])`,
 *    `email` a domain over citext, `mood` an enum with a plpgsql operator `@@@ (mood, mood)`;
 *  - `v_ci` selects `t.id, t.name_ci`, `v_id` only `t.id`;
 *  - `public.lower(varchar)` and an aggregate `public.count(int)` with a plpgsql transition
 *    function exist, v1 filters on a STABLE plpgsql `evil(1)`, v6 uses an operator
 *    `public.@@@ (text, text)`, v7 unions v1 with a table under a policy calling
 *    `pg_backend_pid()`, and the domain `posint` has a check calling it too.
 * An extension's functions are not trusted, so citext's `max(citext)` is a shadow, and citext's
 * input and output functions make its type, its array and the domain over it types whose values
 * run extension code.
 */
const CAPTURED = String.raw`{"views" : [["public", "v_ci", " SELECT t.id,\n    t.name_ci\n   FROM public.t;"], ["public", "v_id", " SELECT t.id\n   FROM public.t;"], ["public", "v5", " SELECT public.lower(t.name) AS l\n   FROM public.t;"], ["public", "v6", " SELECT ((t.name)::text OPERATOR(public.@@@) 'x'::text) AS y\n   FROM public.t;"], ["public", "v7", " SELECT v1.id\n   FROM public.v1\nUNION ALL\n SELECT secrets.id\n   FROM public.secrets;"], ["public", "plain", " SELECT t.id,\n    lower((t.name)::text) AS l,\n    count(*) OVER () AS count\n   FROM public.t;"], ["public", "v1", " SELECT t.id\n   FROM public.t\n  WHERE (t.id = public.evil(1));"]], "policies" : [["secrets", "own", "((owner = CURRENT_USER) AND (pg_backend_pid() > 0))"]], "generated" : null, "domains" : [["posint", ["(pg_backend_pid() > 0)", "(VALUE > 0)"]]], "shadowed" : ["count", "lower", "max"], "types" : [["16385", "citext", "public.citext", "io"], ["16390", "_citext", "public.citext[]", "io"], ["16490", "mood", "public.mood", ""], ["16489", "_mood", "public.mood[]", ""], ["16535", "email", "public.email", "io"], ["16534", "_email", "public.email[]", "io"]], "columns" : [["t", "m", "16490", false], ["t", "name_ci", "16385", false], ["v_ci", "name_ci", "16385", false], ["u", "tags", "16390", false], ["u", "e", "16535", false]], "operators" : [["=", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, true], ["<>", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, false], ["<", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, true], [">", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, true], ["~", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, false], ["~*", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, false], ["!~", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, false], ["!~*", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, false], ["~~", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, false], ["~~*", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, false], ["!~~", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, false], ["!~~*", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, false], ["~", "b", ["16385", "16390", "16534", "16535"], "any", true, false], ["~*", "b", ["16385", "16390", "16534", "16535"], "any", true, false], ["!~", "b", ["16385", "16390", "16534", "16535"], "any", true, false], ["!~*", "b", ["16385", "16390", "16534", "16535"], "any", true, false], ["~~", "b", ["16385", "16390", "16534", "16535"], "any", true, false], ["~~*", "b", ["16385", "16390", "16534", "16535"], "any", true, false], ["!~~", "b", ["16385", "16390", "16534", "16535"], "any", true, false], ["!~~*", "b", ["16385", "16390", "16534", "16535"], "any", true, false], ["<=", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, true], [">=", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, true], ["~<~", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, false], ["~<=~", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, false], ["~>=~", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, false], ["~>~", "b", ["16385", "16390", "16534", "16535"], ["16385", "16390", "16534", "16535"], true, false], ["@@@", "b", ["16489", "16490"], ["16489", "16490"], false, false], ["@@@", "b", "any", "any", false, false]]}`;

const captured = parsePostgresReach(CAPTURED);
const nothing: PostgresReach = { views: [], policies: [], generated: [], domains: [], shadowed: [], types: [], columns: [], operators: [] };
const only = (part: Partial<PostgresReach>): PostgresReach => ({ ...nothing, ...part });
const view = (name: string) => captured.views.find((v) => v[1] === name)!;
/** What the catalog says about citext and mood on that database: their types, columns and operators, no views. */
const extension = only({ types: captured.types, columns: captured.columns, operators: captured.operators });

function verdict(sql: string, reach: PostgresReach) {
  const called = new Set<string>();
  expect(assistantSqlSafety(sql, "postgres", called).proven).toBe(true);
  return postgresReachVerdict(sql, called, reach);
}

const code = (sql: string): string => sqlCode(splitSqlStatements(sql, "postgres")[0]!, "postgres");

describe("nameCandidates", () => {
  it("reads every word, folded the way the server folds a bare name, and every quoted name", () => {
    const names = nameCandidates('SELECT * FROM Sales.MyView, "Odd Name", "a""b" WHERE x = \'"tricky\'', "postgres")!;
    for (const n of ["sales", "Sales", "myview", "MyView", "Odd Name", 'a"b', "tricky"]) expect(names).toContain(n);
  });

  it("finds a quoted name even when a quote inside a string would pair with it", () => {
    expect(nameCandidates(`SELECT 'say "hi' || x FROM "Hidden View"`, "postgres")).toContain("Hidden View");
  });

  it("cuts a Postgres name to the 63 bytes Postgres keeps, and reads MySQL backticks", () => {
    const long = "v".repeat(70);
    expect(nameCandidates(`SELECT * FROM ${long}`, "postgres")).toContain("v".repeat(63));
    expect(clipUtf8("é".repeat(40), 63)).toBe("é".repeat(31));
    expect(nameCandidates("SELECT * FROM `My View`", "mysql")).toContain("My View");
  });

  it("gives up rather than send an unbounded list", () => {
    expect(nameCandidates(Array.from({ length: 5_000 }, (_, i) => `c${i}`).join(","), "postgres")).toBeNull();
  });
});

describe("mentionsName", () => {
  it("matches a whole word, ignoring case", () => {
    expect(mentionsName(["SELECT 1::PosInt"], "posint")).toBe(true);
    expect(mentionsName(["SELECT posint_x FROM t"], "posint")).toBe(false);
    expect(mentionsName(['SELECT 1::"my""dom"'], 'my"dom')).toBe(true);
  });
});

describe("rowUse", () => {
  const watched = new Set(["t"]);
  it("sees every way a query reads columns it does not name", () => {
    for (const sql of ["SELECT * FROM t", "SELECT a.* FROM t a", "SELECT x, * FROM t", "SELECT DISTINCT ON (id) * FROM t", "TABLE t", "SELECT 1 FROM t NATURAL JOIN u"]) {
      expect(rowUse(code(sql), watched).all).toBe(true);
    }
  });

  it("sees a relation or its alias read as a whole row, and an alias list renaming its columns", () => {
    for (const sql of ["SELECT t FROM t", "SELECT to_json(x) FROM t x", "SELECT json_agg(x) FROM public.t AS x", "SELECT b FROM t AS x(a, b)", "SELECT 1 FROM u, t WHERE t IS NOT NULL"]) {
      expect([...rowUse(code(sql), watched).whole]).toEqual(["t"]);
    }
  });

  it("does not count a count(*), a column qualified by the relation, or a relation in FROM", () => {
    for (const sql of ["SELECT count(*) FROM t WHERE id = 1", "SELECT count(*) * 2 FROM t", "SELECT t.id, x.id FROM t, t x WHERE t.id = x.id", "SELECT id FROM t JOIN u ON u.id = t.id"]) {
      expect(rowUse(code(sql), watched)).toEqual({ all: false, whole: new Set() });
    }
  });

  it("counts a quoted name read as a value when a quoted relation is in FROM, since its text is blanked", () => {
    expect(rowUse(code('SELECT "x" FROM "T"'), watched).all).toBe(true);
    expect(rowUse(code('SELECT "x" FROM t'), watched).all).toBe(false);
  });
});

describe("operatorUses", () => {
  const uses = (sql: string) => operatorUses(code(sql));
  it("finds written operators and whether an untyped literal may stand on each side", () => {
    expect(uses("SELECT 1 FROM t WHERE id = 1")).toEqual([{ symbol: "=", written: true, leftLiteral: false, rightLiteral: false }]);
    expect(uses("SELECT 'a' = 'b'")[0]).toMatchObject({ leftLiteral: true, rightLiteral: true });
    expect(uses("SELECT ('a') = NULL")[0]).toMatchObject({ leftLiteral: true, rightLiteral: true });
    expect(uses("SELECT lower(x) = E'b'")[0]).toMatchObject({ leftLiteral: false, rightLiteral: true });
  });

  it("finds the operators keywords stand for, located where Postgres puts their operands", () => {
    const like = uses("SELECT 1 FROM t WHERE name NOT LIKE 'a%'");
    expect(like.map((u) => u.symbol)).toEqual(["~~", "!~~"]);
    expect(like[0]).toMatchObject({ written: false, leftLiteral: false, rightLiteral: true });
    expect(uses("SELECT 1 WHERE 'a' IN ('b')").find((u) => u.symbol === "=")).toMatchObject({ leftLiteral: true, rightLiteral: true });
    expect(uses("SELECT x IS DISTINCT FROM 'a' FROM t").map((u) => u.symbol)).toEqual(["="]);
    expect(uses("SELECT DISTINCT x FROM t")).toEqual([]);
  });

  it("reads a run of operator characters as holding each operator in it, and != as <>", () => {
    const [use] = uses("SELECT a != b FROM t");
    expect(usesOperator(use!, "<>")).toBe(true);
    expect(usesOperator({ symbol: "~~", written: false, leftLiteral: false, rightLiteral: false }, "~")).toBe(false);
  });
});

describe("postgresReachSql", () => {
  it("is a plain read that pins the search path and a timeout first, and carries names only as hex", () => {
    const sql = postgresReachSql(["it's", "x\\y"]);
    expect(isReadOnlyQuery(sql, "postgres")).toBe(true);
    expect(sql).toStartWith("SELECT pg_catalog.set_config('search_path', 'pg_catalog', true), pg_catalog.set_config('statement_timeout', '5000', true);");
    expect(sql).not.toContain("it's");
    expect(sql).not.toContain("x\\y");
  });
});

describe("postgresReachVerdict", () => {
  it("proves a read whose views call only pg_catalog functions", () => {
    expect(verdict("SELECT * FROM plain", only({ views: [view("plain")] }))).toEqual({ proven: true });
    expect(verdict("SELECT count(*), lower(name) FROM t", nothing)).toEqual({ proven: true });
  });

  it("does not prove a view calling a function off the list, at any depth", () => {
    expect(verdict("SELECT * FROM v7", only({ views: [view("v7"), view("v1")] }))).toEqual({
      proven: false, reason: "it reads the view public.v1, whose definition calls public.evil(), a function outside the known-safe list",
    });
  });

  it("does not prove a view whose call resolved to a user function shadowing a built-in", () => {
    expect(verdict("SELECT * FROM v5", only({ views: [view("v5")] })).proven).toBe(false);
  });

  it("does not prove a view using a user operator", () => {
    expect(verdict("SELECT * FROM v6", only({ views: [view("v6")] })).proven).toBe(false);
  });

  it("does not prove a table whose row-level security policy calls a function off the list", () => {
    expect(verdict("SELECT * FROM secrets", only({ policies: captured.policies }))).toEqual({
      proven: false, reason: "it reads secrets, whose row-level security policy own calls pg_backend_pid(), which is not on PPM's list of functions known to only read",
    });
  });

  it("does not prove a conversion to a domain whose check calls one, but ignores a domain it never names", () => {
    expect(verdict("SELECT 1::posint", only({ domains: captured.domains })).proven).toBe(false);
    expect(verdict("SELECT 1", only({ domains: captured.domains }))).toEqual({ proven: true });
  });

  it("does not prove a call that a same-named user function could answer", () => {
    expect(verdict("SELECT lower(name) FROM t", only({ shadowed: captured.shadowed }))).toMatchObject({
      proven: false, reason: expect.stringContaining("also has a function named lower"),
    });
    expect(verdict("SELECT pg_catalog.lower(name) FROM t", only({ shadowed: ["lower"] }))).toEqual({ proven: true });
    expect(verdict("SELECT upper(name) FROM t", only({ shadowed: captured.shadowed }))).toEqual({ proven: true });
  });

  it("does not trust an extension's functions: its aggregate shadows a safe-listed call", () => {
    expect(verdict("SELECT max(id) FROM t", only({ shadowed: captured.shadowed }))).toMatchObject({
      proven: false, reason: expect.stringContaining("also has a function named max"),
    });
  });

  it("counts only Postgres's own IMMUTABLE functions as pure, whatever the language or who installed it", () => {
    const sql = postgresReachSql(["max"]);
    expect(sql).toContain("p.provolatile = 'i' AND p.pronamespace IN (SELECT oid FROM sys)");
    expect(sql).not.toContain("deptype = 'e'");
    expect(sql).not.toContain("'internal'");
  });

  it("does not prove a user function written as a row's column, which Postgres calls with no parenthesis", () => {
    for (const sql of ["SELECT t.evil FROM t", "SELECT (t).evil FROM t", 'SELECT t."Evil" FROM t']) {
      expect(verdict(sql, only({ shadowed: ["evil", "Evil"] }))).toMatchObject({
        proven: false, reason: expect.stringContaining("written as t."),
      });
    }
    expect(verdict("SELECT t.id FROM t", only({ shadowed: ["evil"] }))).toEqual({ proven: true });
  });

  it("asks the catalog about every word of the query, not only the safe-listed names", () => {
    const sql = postgresReachSql(["t", "evil"]);
    expect(sql).toContain("p.proname IN (SELECT name FROM names)");
    expect(sql).not.toContain("FROM safe");
  });

  it("refuses an answer in an unexpected shape", () => {
    expect(() => parsePostgresReach("{}")).toThrow();
    expect(() => parsePostgresReach(JSON.stringify({ ...nothing, views: [["public", "v"]] }))).toThrow();
    expect(() => parsePostgresReach(JSON.stringify({ ...nothing, operators: [["=", "b", "some", null, true, false]] }))).toThrow();
    expect(() => parsePostgresReach(JSON.stringify({ ...nothing, columns: [["t", "c", "1", "no"]] }))).toThrow();
    expect(() => parsePostgresReach(undefined)).toThrow();
  });
});

describe("postgresReachVerdict with an extension's types and operators (citext)", () => {
  it("proves a comparison of built-in columns, though citext defines =, < and > too", () => {
    for (const sql of [
      "SELECT count(*) FROM t WHERE id = 1",
      "SELECT id FROM t",
      "SELECT x.id FROM t x WHERE x.name LIKE 'a%' AND x.id IN (1, 2) AND x.name <> 'b'",
      "SELECT DISTINCT name FROM t WHERE name BETWEEN 'a' AND 'z' ORDER BY name",
      "SELECT 'a' = 'A'",
      "SELECT id FROM u ORDER BY id",
    ]) {
      expect(verdict(sql, extension)).toEqual({ proven: true });
    }
  });

  it("asks when the query reads a citext column, whose output is extension code", () => {
    expect(verdict("SELECT count(*) FROM t WHERE name_ci = 'x'", extension)).toEqual({
      proven: false, reason: "it reads t.name_ci, of type public.citext, whose input and output functions are outside pg_catalog",
    });
    expect(verdict("SELECT name_ci FROM t", extension).proven).toBe(false);
    // A domain over citext and an array of it carry the same code.
    expect(verdict("SELECT e FROM u", extension)).toMatchObject({ proven: false, reason: expect.stringContaining("public.email") });
    expect(verdict("SELECT id FROM u WHERE 'a' = ANY(tags)", extension)).toMatchObject({ proven: false, reason: expect.stringContaining("public.citext[]") });
  });

  it("asks when the query reads every column of a relation that has one", () => {
    for (const sql of ["SELECT * FROM t", "SELECT t FROM t", "SELECT to_json(x) FROM t x", "TABLE t"]) {
      expect(verdict(sql, extension)).toMatchObject({ proven: false, reason: expect.stringContaining("t.name_ci") });
    }
  });

  it("asks when the query names the type: a cast, CAST(… AS …) or a typed literal", () => {
    for (const sql of ["SELECT 'a'::citext = 'A'", "SELECT CAST('a' AS citext)", "SELECT citext 'a'", "SELECT 'a'::public.citext"]) {
      expect(verdict(sql, extension)).toMatchObject({ proven: false, reason: expect.stringContaining("names the type public.citext") });
    }
  });

  it("asks about a view whose definition reads a citext column, and not about one that does not", () => {
    const reach = { ...extension, views: [view("v_ci")] };
    expect(verdict("SELECT * FROM v_ci", reach)).toMatchObject({ proven: false, reason: expect.stringContaining("name_ci") });
    expect(verdict("SELECT id FROM v_id", { ...extension, views: [view("v_id")] })).toEqual({ proven: true });
  });

  it("asks about a user operator on a user type only where a value of that type meets its symbol", () => {
    // mood's own I/O is Postgres's, so reading it is fine; its plpgsql @@@ is not.
    expect(verdict("SELECT m FROM t WHERE m = 'a'", extension)).toEqual({ proven: true });
    expect(verdict("SELECT m FROM t WHERE m @@@ 'a'", extension)).toMatchObject({
      proven: false, reason: "it may use the operator @@@ on public.mood, which this database defines outside pg_catalog",
    });
  });

  it("asks wherever the symbol of an operator a built-in type can reach is used, as before", () => {
    // public.@@@ (text, text): any text value reaches it.
    expect(verdict("SELECT name::text @@@ 'x' FROM t", extension)).toMatchObject({ proven: false, reason: expect.stringContaining("operator @@@") });
    expect(verdict("SELECT '@@@' FROM t", extension)).toEqual({ proven: true });
  });

  it("asks when untyped literals on every side could resolve to a user operator pg_catalog has no text version of", () => {
    const typedOnly = { ...extension, operators: captured.operators.filter((o) => o.left !== "any") };
    expect(verdict("SELECT 'a' @@@ 'b'", typedOnly)).toMatchObject({ proven: false, reason: expect.stringContaining("operator @@@") });
    expect(verdict("SELECT 'a' = 'b'", typedOnly)).toEqual({ proven: true });
  });

  it("asks when a type has a user operator in its default operator class, which ORDER BY or DISTINCT run unwritten", () => {
    const sorted = only({
      types: [["9", "mood", "public.mood", ""]],
      columns: [["t", "m", "9", false]],
      operators: [{ name: "<", left: ["9"], right: ["9"], shielded: true, implicit: true }],
    });
    expect(verdict("SELECT m FROM t ORDER BY m", sorted)).toMatchObject({ proven: false, reason: expect.stringContaining("sort or compare public.mood") });
    expect(verdict("SELECT id FROM t ORDER BY id", sorted)).toEqual({ proven: true });
  });

  it("asks about a column of a composite type outside pg_catalog, which it does not look inside", () => {
    const reach = only({ columns: [["t", "addr", "7", true]] });
    expect(verdict("SELECT addr FROM t", reach)).toMatchObject({ proven: false, reason: expect.stringContaining("composite") });
    expect(verdict("SELECT id FROM t", reach)).toEqual({ proven: true });
  });
});

describe("MySQL", () => {
  it("asks a plain read of information_schema, names only as hex", () => {
    const sql = mysqlReachSql(["it's", "v"]);
    expect(isReadOnlyQuery(sql, "mysql")).toBe(true);
    expect(sql).not.toContain("it's");
    expect(sql).toContain("information_schema.VIEWS");
    expect(mysqlReachSql([])).not.toContain(" IN ()");
  });

  it("does not prove a read of a view, whatever the case of its name", () => {
    expect(mysqlReachVerdict(["SELECT", "MyView"], new Set(), [["view", "shop", "myview"]])).toMatchObject({ proven: false, reason: expect.stringContaining("shop.myview") });
    expect(mysqlReachVerdict(["SELECT", "orders"], new Set(), [["view", "shop", "myview"]])).toEqual({ proven: true });
  });

  it("does not prove a bare call when the current database has a stored function of that name", () => {
    expect(mysqlReachVerdict([], new Set(["initcap"]), [["function", "shop", "INITCAP"]])).toMatchObject({ proven: false, reason: expect.stringContaining("initcap()") });
    expect(mysqlReachVerdict([], new Set(["lower"]), [["function", "shop", "audit_log"]])).toEqual({ proven: true });
    expect(() => mysqlReachVerdict([], new Set(), [["view", null, "x"]])).toThrow();
  });
});

describe("assistantSqlReachSafety", () => {
  const reader = (answer: () => unknown[][]): CatalogReader & { calls: string[] } => {
    const calls: string[] = [];
    return Object.assign(async (sql: string) => { calls.push(sql); return answer(); }, { calls });
  };

  it("reads no catalog for SQLite", async () => {
    const read = reader(() => []);
    expect(await assistantSqlReachSafety("SELECT * FROM v", "sqlite", new Set(), read)).toEqual({ proven: true });
    expect(read.calls).toHaveLength(0);
  });

  it("proves only on the catalog's word", async () => {
    const read = reader(() => [[JSON.stringify(nothing)]]);
    expect(await assistantSqlReachSafety("SELECT 1", "postgres", new Set(), read)).toEqual({ proven: true });
    expect(read.calls[0]).toContain("pg_get_viewdef");
    const viaView = reader(() => [[CAPTURED]]);
    expect((await assistantSqlReachSafety("SELECT * FROM v7", "postgres", new Set(), viaView)).proven).toBe(false);
    // The same answer for a query that reaches no view, on a database with only citext and mood.
    const typesOnly = JSON.stringify({ ...JSON.parse(CAPTURED), views: null, policies: null, domains: null, shadowed: null });
    const plain = reader(() => [[typesOnly]]);
    expect(await assistantSqlReachSafety("SELECT count(*) FROM t WHERE id = 1", "postgres", new Set(["count"]), plain)).toEqual({ proven: true });
    expect(await assistantSqlReachSafety("SELECT count(*) FROM t WHERE name_ci = 'x'", "postgres", new Set(["count"]), plain)).toMatchObject({ proven: false, reason: expect.stringContaining("t.name_ci") });
  });

  it("does not prove what it could not check: a failed read, a malformed answer, no answer", async () => {
    const failed = await assistantSqlReachSafety("SELECT 1", "postgres", new Set(), async () => { throw new Error("permission denied for table pg_policy"); });
    expect(failed).toMatchObject({ proven: false, reason: expect.stringContaining("permission denied for table pg_policy") });
    expect((await assistantSqlReachSafety("SELECT 1", "postgres", new Set(), reader(() => [["not json"]]))).proven).toBe(false);
    expect((await assistantSqlReachSafety("SELECT 1", "postgres", new Set(), reader(() => []))).proven).toBe(false);
    expect((await assistantSqlReachSafety("SELECT 1", "mysql", new Set(), reader(() => [[1, 2]]))).proven).toBe(false);
  });
});
