import { describe, it, expect } from "bun:test";
import { splitSqlStatements } from "../../../src/web/components/database/split-sql-statements";

const sqlOf = (text: string) => splitSqlStatements(text).map((s) => s.sql);

describe("splitSqlStatements", () => {
  it("splits plain statements and reports their start line", () => {
    const stmts = splitSqlStatements("SELECT 1;\nSELECT 2;");
    expect(stmts).toEqual([
      { sql: "SELECT 1;", startLine: 1, endLine: 1 },
      { sql: "SELECT 2;", startLine: 2, endLine: 2 },
    ]);
  });

  it("ends a statement at the semicolon even with a trailing comment", () => {
    const text = [
      "-- 1. inject",
      "UPDATE self_bill",
      "SET \"pdfDataInjected\" = '{}'::json",
      "WHERE id = 'SFB-1' AND \"pdfDataInjected\" IS NULL;  -- guard: exactly 1 row",
      "",
      "-- rollback",
      "UPDATE self_bill SET \"pdfDataInjected\" = NULL",
      "WHERE id = 'SFB-1';",
    ].join("\n");
    const stmts = splitSqlStatements(text);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.startLine).toBe(2);
    expect(stmts[0]!.sql.endsWith("IS NULL;")).toBe(true);
    expect(stmts[0]!.sql).not.toContain("rollback");
    expect(stmts[1]!.startLine).toBe(7);
  });

  it("starts a statement at its first token, not at leading blanks or comments", () => {
    const stmts = splitSqlStatements("\n\n-- note\n/* block */\nSELECT 1;");
    expect(stmts).toEqual([{ sql: "SELECT 1;", startLine: 5, endLine: 5 }]);
  });

  it("ignores semicolons inside string literals and quoted identifiers", () => {
    expect(sqlOf("SELECT 'a;b';")).toEqual(["SELECT 'a;b';"]);
    expect(sqlOf("SELECT \"we;ird\" FROM t;")).toEqual(['SELECT "we;ird" FROM t;']);
    expect(sqlOf("SELECT 'it''s; fine';")).toEqual(["SELECT 'it''s; fine';"]);
    expect(sqlOf("SELECT E'a\\'; b';")).toEqual(["SELECT E'a\\'; b';"]);
  });

  it("ignores semicolons inside comments", () => {
    expect(sqlOf("SELECT 1 -- ; not an end\n, 2;")).toEqual(["SELECT 1 -- ; not an end\n, 2;"]);
    expect(sqlOf("SELECT /* ; */ 1;")).toEqual(["SELECT /* ; */ 1;"]);
    expect(sqlOf("SELECT /* a /* ; */ b */ 1;")).toEqual(["SELECT /* a /* ; */ b */ 1;"]);
  });

  it("keeps a dollar-quoted body in one statement", () => {
    const text = "DO $$ BEGIN RAISE NOTICE 'x'; END $$;\nSELECT 1;";
    expect(sqlOf(text)).toEqual(["DO $$ BEGIN RAISE NOTICE 'x'; END $$;", "SELECT 1;"]);
    const tagged = "CREATE FUNCTION f() RETURNS int AS $fn$ SELECT 1; $fn$ LANGUAGE sql;";
    expect(sqlOf(tagged)).toEqual([tagged]);
  });

  it("does not treat positional parameters as dollar quotes", () => {
    expect(sqlOf("SELECT * FROM t WHERE id = $1;\nSELECT 2;"))
      .toEqual(["SELECT * FROM t WHERE id = $1;", "SELECT 2;"]);
  });

  it("keeps a trailing statement that has no semicolon", () => {
    const stmts = splitSqlStatements("SELECT 1;\nSELECT 2");
    expect(stmts[1]).toEqual({ sql: "SELECT 2", startLine: 2, endLine: 2 });
  });

  it("returns nothing for blank or comment-only input", () => {
    expect(splitSqlStatements("")).toEqual([]);
    expect(splitSqlStatements("\n\n")).toEqual([]);
    expect(splitSqlStatements("-- just a note\n/* and another */")).toEqual([]);
  });

  it("tracks line numbers across multi-line literals and comments", () => {
    const text = "SELECT '\nmulti\nline';\nSELECT 2;";
    const stmts = splitSqlStatements(text);
    expect(stmts[0]!.endLine).toBe(3);
    expect(stmts[1]!.startLine).toBe(4);
  });
});
