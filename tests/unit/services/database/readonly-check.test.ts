import { describe, it, expect } from "bun:test";
import { isReadOnlyQuery } from "../../../../src/services/database/readonly-check.ts";

describe("isReadOnlyQuery", () => {
  // ── Read-only (should return true) ─────────────────────────────────
  it("allows SELECT", () => {
    expect(isReadOnlyQuery("SELECT * FROM users")).toBe(true);
  });

  it("allows SELECT with leading whitespace", () => {
    expect(isReadOnlyQuery("  SELECT 1")).toBe(true);
  });

  it("allows EXPLAIN", () => {
    expect(isReadOnlyQuery("EXPLAIN SELECT * FROM users")).toBe(true);
  });

  it("allows SHOW", () => {
    expect(isReadOnlyQuery("SHOW TABLES")).toBe(true);
  });

  it("allows PRAGMA", () => {
    expect(isReadOnlyQuery("PRAGMA table_info('users')")).toBe(true);
  });

  it("allows DESCRIBE", () => {
    expect(isReadOnlyQuery("DESCRIBE users")).toBe(true);
  });

  it("allows WITH ... SELECT (plain CTE)", () => {
    expect(isReadOnlyQuery("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe(true);
  });

  // ── Write (should return false) ────────────────────────────────────
  it("blocks INSERT", () => {
    expect(isReadOnlyQuery("INSERT INTO users (name) VALUES ('a')")).toBe(false);
  });

  it("blocks UPDATE", () => {
    expect(isReadOnlyQuery("UPDATE users SET name = 'b' WHERE id = 1")).toBe(false);
  });

  it("blocks DELETE", () => {
    expect(isReadOnlyQuery("DELETE FROM users WHERE id = 1")).toBe(false);
  });

  it("blocks DROP", () => {
    expect(isReadOnlyQuery("DROP TABLE users")).toBe(false);
  });

  it("blocks CREATE", () => {
    expect(isReadOnlyQuery("CREATE TABLE foo (id INTEGER)")).toBe(false);
  });

  it("blocks ALTER", () => {
    expect(isReadOnlyQuery("ALTER TABLE users ADD COLUMN age INTEGER")).toBe(false);
  });

  it("blocks TRUNCATE", () => {
    expect(isReadOnlyQuery("TRUNCATE TABLE users")).toBe(false);
  });

  it("blocks REPLACE", () => {
    expect(isReadOnlyQuery("REPLACE INTO users (id, name) VALUES (1, 'a')")).toBe(false);
  });

  it("blocks MERGE", () => {
    expect(isReadOnlyQuery("MERGE INTO target USING source ON ...")).toBe(false);
  });

  // ── CTE attack patterns ────────────────────────────────────────────
  it("blocks CTE with DELETE", () => {
    expect(isReadOnlyQuery("WITH x AS (DELETE FROM users) SELECT * FROM x")).toBe(false);
  });

  it("blocks CTE with INSERT", () => {
    expect(isReadOnlyQuery("WITH x AS (INSERT INTO users VALUES (1)) SELECT 1")).toBe(false);
  });

  // ── Case insensitivity ─────────────────────────────────────────────
  it("is case-insensitive for keywords", () => {
    expect(isReadOnlyQuery("select * from users")).toBe(true);
    expect(isReadOnlyQuery("insert into users values (1)")).toBe(false);
  });

  // ── String literals (should NOT trigger false positives) ──────────
  it("allows SELECT with write keyword inside string literal", () => {
    expect(isReadOnlyQuery("SELECT CASE WHEN x THEN 'NEEDS UPDATE' ELSE 'OK' END FROM t")).toBe(true);
  });

  it("allows SELECT with DELETE inside string literal", () => {
    expect(isReadOnlyQuery("SELECT 'DELETE ME' AS label FROM t")).toBe(true);
  });

  it("allows SELECT with INSERT inside string literal", () => {
    expect(isReadOnlyQuery("SELECT * FROM t WHERE status = 'INSERT PENDING'")).toBe(true);
  });

  it("still blocks real UPDATE even with string literals", () => {
    expect(isReadOnlyQuery("UPDATE t SET x = 'hello' WHERE id = 1")).toBe(false);
  });

  // ── Edge cases ─────────────────────────────────────────────────────
  it("rejects empty string", () => {
    expect(isReadOnlyQuery("")).toBe(false);
  });

  it("rejects random text", () => {
    expect(isReadOnlyQuery("hello world")).toBe(false);
  });

  it("rejects a script with nothing but comments and semicolons", () => {
    expect(isReadOnlyQuery("-- SELECT 1\n;;")).toBe(false);
  });

  // ── Every statement counts ─────────────────────────────────────────
  it("blocks a write after a read", () => {
    expect(isReadOnlyQuery("SELECT 1; DELETE FROM t")).toBe(false);
    expect(isReadOnlyQuery("SELECT 1; SET search_path = x")).toBe(false);
  });

  it("allows several reads, and a trailing semicolon", () => {
    expect(isReadOnlyQuery("SELECT 1; SELECT 2;")).toBe(true);
  });

  it("blocks a write hidden after an escape string that a naive reader takes for unterminated", () => {
    expect(isReadOnlyQuery("SELECT E'\\''; DELETE FROM t")).toBe(false);
  });

  // ── Reads that write ───────────────────────────────────────────────
  it("blocks SELECT INTO, which creates a table", () => {
    expect(isReadOnlyQuery("SELECT * INTO copy FROM users")).toBe(false);
  });

  it("blocks EXPLAIN ANALYZE of a write, which runs it", () => {
    expect(isReadOnlyQuery("EXPLAIN ANALYZE DELETE FROM users")).toBe(false);
  });

  it("blocks a CTE that updates", () => {
    expect(isReadOnlyQuery("WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x")).toBe(false);
  });

  // ── What it no longer mistakes for a write ─────────────────────────
  it("allows the replace() function", () => {
    expect(isReadOnlyQuery("SELECT replace(name, 'a', 'b') FROM users")).toBe(true);
  });

  it("ignores keywords in quoted names, comments and dollar quotes", () => {
    expect(isReadOnlyQuery('SELECT "delete", "update" FROM t')).toBe(true);
    expect(isReadOnlyQuery("SELECT 1 -- DELETE FROM t")).toBe(true);
    expect(isReadOnlyQuery("/* DROP TABLE t */ SELECT 1")).toBe(true);
    expect(isReadOnlyQuery("SELECT $$DELETE FROM t$$, $tag$ DROP $tag$")).toBe(true);
  });

  it("allows VALUES, TABLE and a parenthesised union", () => {
    expect(isReadOnlyQuery("VALUES (1), (2)")).toBe(true);
    expect(isReadOnlyQuery("TABLE users")).toBe(true);
    expect(isReadOnlyQuery("(SELECT 1) UNION (SELECT 2)")).toBe(true);
  });

  it("reads SQLite's own quoting when told the dialect", () => {
    expect(isReadOnlyQuery("SELECT `delete`, [update] FROM t", "sqlite")).toBe(true);
    // Postgres has no backtick names, so there the word is code.
    expect(isReadOnlyQuery("SELECT `delete` FROM t", "postgres")).toBe(false);
  });
});

describe("isReadOnlyQuery on MySQL", () => {
  const ro = (sql: string) => isReadOnlyQuery(sql, "mysql");

  it("allows reads, and names that only look like keywords", () => {
    expect(ro("SELECT * FROM t")).toBe(true);
    expect(ro("SELECT `into`, `delete` FROM `update`")).toBe(true);
    expect(ro("SHOW CREATE TABLE t; DESCRIBE t; EXPLAIN FORMAT=JSON SELECT 1")).toBe(true);
    expect(ro("SELECT 1 # DELETE FROM t")).toBe(true);
    expect(ro("SELECT 1 -- DELETE FROM t")).toBe(true);
    expect(ro("SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM t")).toBe(true);
  });

  it("blocks writing a file on the server", () => {
    expect(ro("SELECT * FROM t INTO OUTFILE '/tmp/x'")).toBe(false);
    expect(ro("SELECT * FROM t INTO DUMPFILE '/tmp/x'")).toBe(false);
  });

  it("reads a string both ways, so NO_BACKSLASH_ESCAPES cannot hide a write", () => {
    // With backslash escapes this is one long string; without them, INTO OUTFILE is code.
    expect(ro(String.raw`SELECT 'x\' INTO OUTFILE '/tmp/f' -- '`)).toBe(false);
    expect(ro(String.raw`SELECT 'it\'s' FROM t`)).toBe(true);
  });

  it("runs what an executable comment holds, so it counts as code", () => {
    expect(ro("/*!50000 DELETE FROM t */")).toBe(false);
    expect(ro("SELECT /*!50000 * FROM t INTO OUTFILE '/tmp/x' */")).toBe(false);
    expect(ro("SELECT /*M! 1 INTO @x */")).toBe(false);
  });

  it("blocks leaving the read-only transaction or changing the session", () => {
    expect(ro("SET SESSION transaction_read_only = OFF")).toBe(false);
    expect(ro("SELECT 1; COMMIT; DELETE FROM t")).toBe(false);
    expect(ro("USE other_db")).toBe(false);
    expect(ro("CALL p()")).toBe(false);
    expect(ro("DO SLEEP(1)")).toBe(false);
  });

  it("reads a DELIMITER script by its statements, not its lines", () => {
    expect(ro("DELIMITER //\nSELECT 1 //\nSELECT 2 //\nDELIMITER ;")).toBe(true);
    expect(ro("DELIMITER //\nSELECT 1 //\nDELETE FROM t //\nDELIMITER ;")).toBe(false);
  });
});
