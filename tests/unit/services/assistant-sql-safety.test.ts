/**
 * The Assistant runs a query without asking only when it is proven to read. A read-only
 * transaction is not proof: functions with side effects run inside one, and a PRAGMA can set
 * what it names. Anything the check cannot prove is left for the user to approve.
 */
import { describe, expect, it } from "bun:test";
import { assistantSqlSafety } from "../../../src/services/assistant-mcp/assistant-sql-safety.ts";

const proven = (sql: string, dialect: "postgres" | "mysql" | "sqlite" = "postgres") => assistantSqlSafety(sql, dialect).proven;

describe("assistantSqlSafety", () => {
  it("proves plain reads that call only ordinary functions", () => {
    expect(proven("SELECT count(*), lower(name) FROM t")).toBe(true);
    expect(proven("SELECT count(*), lower(name) FROM t", "mysql")).toBe(true);
    expect(proven("SELECT count(*), lower(name) FROM t", "sqlite")).toBe(true);
    expect(proven("SELECT id FROM orders WHERE status IN ('a', 'b') AND EXISTS (SELECT 1 FROM x WHERE x.id = orders.id)")).toBe(true);
    expect(proven("WITH recent AS (SELECT * FROM t WHERE created_at > now() - interval '1 day') SELECT date_trunc('day', created_at), sum(total) FROM recent GROUP BY 1")).toBe(true);
    expect(proven("SELECT CAST(x AS varchar(10)), y::numeric(10,2), coalesce(z, 0) FROM t")).toBe(true);
    expect(proven("SELECT row_number() OVER (PARTITION BY a ORDER BY b) FROM t")).toBe(true);
    expect(proven("SELECT pg_catalog.lower(name) FROM t")).toBe(true);
    expect(proven("SHOW TABLES", "mysql")).toBe(true);
    expect(proven("EXPLAIN SELECT * FROM t")).toBe(true);
    expect(proven("PRAGMA table_info(users)", "sqlite")).toBe(true);
    expect(proven("PRAGMA user_version", "sqlite")).toBe(true);
    // A function name inside a string or a comment calls nothing.
    expect(proven("SELECT 'pg_terminate_backend(1)' AS note -- pg_sleep(5)")).toBe(true);
  });

  it("does not prove an assigning PRAGMA, or one it does not know", () => {
    expect(proven("PRAGMA x = 1", "sqlite")).toBe(false);
    expect(proven("PRAGMA user_version = 5", "sqlite")).toBe(false);
    expect(proven("PRAGMA user_version(5)", "sqlite")).toBe(false);
    expect(proven("PRAGMA journal_mode=WAL", "sqlite")).toBe(false);
    expect(proven("PRAGMA optimize", "sqlite")).toBe(false);
  });

  it("does not prove a call to a function with side effects", () => {
    expect(proven("SELECT pg_terminate_backend(1)")).toBe(false);
    expect(proven("SELECT dblink_exec('host=x', 'DELETE FROM t')")).toBe(false);
    expect(proven("SELECT GET_LOCK('a',1)", "mysql")).toBe(false);
    expect(proven("SELECT nextval('s')")).toBe(false);
    expect(proven("SELECT pg_sleep(600)")).toBe(false);
    expect(proven("SELECT SLEEP(10)", "mysql")).toBe(false);
    expect(proven("SELECT set_config('a', 'b', false)")).toBe(false);
    expect(proven("SELECT pg_advisory_lock(1)")).toBe(false);
  });

  it("does not prove a function it cannot name, or one in another schema", () => {
    expect(proven('SELECT "pg_terminate_backend"(1)')).toBe(false);
    expect(proven('SELECT "evil".lower(name) FROM t')).toBe(false);
    expect(proven("SELECT public.lower(name) FROM t")).toBe(false);
    expect(proven("SELECT `GET_LOCK`('a', 1)", "mysql")).toBe(false);
  });

  it("does not prove locking reads, variable assignment or anything that is not a read", () => {
    expect(proven("SELECT * FROM t FOR UPDATE")).toBe(false);
    expect(proven("SELECT * FROM t LOCK IN SHARE MODE", "mysql")).toBe(false);
    expect(proven("SELECT @x := 1", "mysql")).toBe(false);
    expect(proven("DELETE FROM t")).toBe(false);
    expect(proven("SELECT 1; DROP TABLE t")).toBe(false);
    expect(proven("SELECT * INTO copy FROM t")).toBe(false);
    expect(proven("")).toBe(false);
  });

  it("says why", () => {
    const verdict = assistantSqlSafety("SELECT pg_terminate_backend(1)", "postgres");
    expect(verdict).toEqual({ proven: false, reason: expect.stringContaining("pg_terminate_backend()") });
  });
});
