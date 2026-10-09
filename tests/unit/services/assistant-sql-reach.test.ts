/**
 * A query's text can pass the safe-list check and still reach a side effect: through a view, a
 * row-level security policy, a domain's check, a user function named like a built-in, or a user
 * operator. The catalog check asks the database what the query reaches; anything it cannot
 * answer with certainty is "not proven", so the user is asked rather than the query run.
 */
import { describe, expect, it } from "bun:test";
import { clipUtf8, mentionsName, nameCandidates } from "../../../src/services/assistant-mcp/assistant-sql-reach-names.ts";
import { parsePostgresReach, postgresReachSql, postgresReachVerdict, type PostgresReach } from "../../../src/services/assistant-mcp/assistant-sql-reach-postgres.ts";
import { mysqlReachSql, mysqlReachVerdict } from "../../../src/services/assistant-mcp/assistant-sql-reach-mysql.ts";
import { assistantSqlReachSafety, type CatalogReader } from "../../../src/services/assistant-mcp/assistant-sql-reach-check.ts";
import { assistantSqlSafety } from "../../../src/services/assistant-mcp/assistant-sql-safety.ts";
import { isReadOnlyQuery } from "../../../src/services/database/readonly-check.ts";

/**
 * The catalog query's answer on Postgres 15 for `SELECT * FROM v5, v6, v7, plain, notes`, where
 * `public.lower(varchar)` and an aggregate `public.count(int)` with a plpgsql transition function
 * exist, v1 filters on a STABLE plpgsql `evil(1)`, v7 unions v1 with a table under a policy
 * calling `pg_backend_pid()`, and citext is installed (its max/min and SQL wrappers are not shadows).
 */
const CAPTURED = String.raw`{"views" : [["public", "v5", " SELECT public.lower(t.name) AS l\n   FROM public.t;"], ["public", "v6", " SELECT ((t.name)::text OPERATOR(public.@@@) 'x'::text) AS y\n   FROM public.t;"], ["public", "v7", " SELECT v1.id\n   FROM public.v1\nUNION ALL\n SELECT secrets.id\n   FROM public.secrets;"], ["public", "plain", " SELECT t.id,\n    lower((t.name)::text) AS l,\n    count(*) OVER () AS count\n   FROM public.t;"], ["public", "v1", " SELECT t.id\n   FROM public.t\n  WHERE (t.id = public.evil(1));"]], "policies" : [["secrets", "own", "((owner = CURRENT_USER) AND (pg_backend_pid() > 0))"]], "generated" : null, "domains" : [["posint", ["(pg_backend_pid() > 0)", "(VALUE > 0)"]]], "shadowed" : ["count", "lower"], "operators" : ["@@@"], "castTypes" : null, "castColumns" : false}`;

const captured = parsePostgresReach(CAPTURED);
const nothing: PostgresReach = { views: [], policies: [], generated: [], domains: [], shadowed: [], operators: [], castTypes: [], castColumns: false };
const only = (part: Partial<PostgresReach>): PostgresReach => ({ ...nothing, ...part });
const view = (name: string) => captured.views.find((v) => v[1] === name)!;

function verdict(sql: string, reach: PostgresReach) {
  const called = new Set<string>();
  expect(assistantSqlSafety(sql, "postgres", called).proven).toBe(true);
  return postgresReachVerdict(sql, called, reach);
}

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

  it("does not prove the use of a symbol a user operator also has, but ignores one inside a string", () => {
    expect(verdict("SELECT a @@@ b FROM t", only({ operators: ["@@@"] })).proven).toBe(false);
    expect(verdict("SELECT '@@@' FROM t", only({ operators: ["@@@"] }))).toEqual({ proven: true });
  });

  it("does not prove a read that may run a user cast", () => {
    expect(verdict("SELECT * FROM t", only({ castColumns: true })).proven).toBe(false);
    expect(verdict("SELECT 'a'::mood::text", only({ castTypes: ["mood"] })).proven).toBe(false);
  });

  it("refuses an answer in an unexpected shape", () => {
    expect(() => parsePostgresReach("{}")).toThrow();
    expect(() => parsePostgresReach(JSON.stringify({ ...nothing, views: [["public", "v"]] }))).toThrow();
    expect(() => parsePostgresReach(undefined)).toThrow();
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
  });

  it("does not prove what it could not check: a failed read, a malformed answer, no answer", async () => {
    const failed = await assistantSqlReachSafety("SELECT 1", "postgres", new Set(), async () => { throw new Error("permission denied for table pg_policy"); });
    expect(failed).toMatchObject({ proven: false, reason: expect.stringContaining("permission denied for table pg_policy") });
    expect((await assistantSqlReachSafety("SELECT 1", "postgres", new Set(), reader(() => [["not json"]]))).proven).toBe(false);
    expect((await assistantSqlReachSafety("SELECT 1", "postgres", new Set(), reader(() => []))).proven).toBe(false);
    expect((await assistantSqlReachSafety("SELECT 1", "mysql", new Set(), reader(() => [[1, 2]]))).proven).toBe(false);
  });
});
