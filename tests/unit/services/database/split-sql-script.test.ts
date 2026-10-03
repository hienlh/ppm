import { describe, expect, it } from "bun:test";
import { lineOfPosition, splitSqlScript, splitSqlStatements } from "../../../../src/shared/split-sql-statements.ts";
import type { DialectName } from "../../../../src/shared/db-types.ts";

/** Scripts the server already splits with `splitSqlStatements`; the Query tab must run the same statements. */
const SCRIPTS: [DialectName, string][] = [
  ["postgres", "SELECT 1; ;SELECT 2;\n"],
  ["postgres", "-- lead\nSELECT 1; -- done\n/* really */"],
  ["postgres", "SELECT ';', \"a;b\"; SELECT 'it''s; fine'; SELECT E'x\\'; y'; SELECT 3"],
  ["postgres", "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql;\n\nSELECT $$a;b$$"],
  ["postgres", "/* a /* nested; */ still */ SELECT 1;\n  \n  SELECT\n    2\n  ;"],
  ["mysql", "SELECT 1; # note; here\nSELECT `a;b` FROM t;\nSELECT 'x\\'; y'"],
  ["mysql", "DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END //\nDELIMITER ;\nCALL p();"],
  ["mysql", "SELECT 1\nDELIMITER $$\nSELECT 2 $$"],
  ["mysql", "/*!40101 SET NAMES utf8 */; SELECT 1--1;\nSELECT 2"],
  ["sqlite", "SELECT [a;b] FROM t; SELECT `c;d`; SELECT 'e;f'"],
];

describe("splitSqlScript", () => {
  it("gives the statements splitSqlStatements gives, so the tab runs what /query would", () => {
    for (const [dialect, script] of SCRIPTS) {
      expect(splitSqlScript(script, dialect).map((s) => s.sql)).toEqual(splitSqlStatements(script, dialect));
    }
  });

  it("follows the server's backslash setting the way splitSqlStatements does", () => {
    const script = "SELECT 'a\\'; SELECT 2";
    for (const backslashEscapes of [true, false]) {
      const statements = splitSqlScript(script, "mysql", { backslashEscapes }).map((s) => s.sql);
      expect(statements).toEqual(splitSqlStatements(script, "mysql", { backslashEscapes }));
    }
    expect(splitSqlScript(script, "mysql", { backslashEscapes: false })).toHaveLength(2);
    expect(splitSqlScript(script, "mysql", { backslashEscapes: true })).toHaveLength(1);
  });

  it("says where each statement starts and ends, a comment in front of it apart", () => {
    const script = [
      "-- the users",           // 1
      "SELECT *",               // 2
      "FROM users",             // 3
      "WHERE id = 1;",          // 4
      "",                       // 5
      "UPDATE users SET a = 1", // 6
      "  WHERE id = 2",         // 7
      ";SELECT 3",              // 8
      "",                       // 9
    ].join("\n");
    expect(splitSqlScript(script)).toEqual([
      { sql: "-- the users\nSELECT *\nFROM users\nWHERE id = 1", firstLine: 1, startLine: 2, endLine: 4 },
      { sql: "UPDATE users SET a = 1\n  WHERE id = 2", firstLine: 6, startLine: 6, endLine: 8 },
      { sql: "SELECT 3", firstLine: 8, startLine: 8, endLine: 8 },
    ]);
  });

  it("keeps a procedure body under DELIMITER whole, and ends the last statement on its last character", () => {
    const script = "SELECT 1;\nDELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND $$\nDELIMITER ;\nCALL p()\n\n";
    expect(splitSqlScript(script, "mysql")).toEqual([
      { sql: "SELECT 1", firstLine: 1, startLine: 1, endLine: 1 },
      { sql: "CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND", firstLine: 3, startLine: 3, endLine: 6 },
      { sql: "CALL p()", firstLine: 8, startLine: 8, endLine: 8 },
    ]);
  });

  it("counts a statement that starts with a string from that string", () => {
    expect(splitSqlScript("\n\n  'abc';")).toEqual([{ sql: "'abc'", firstLine: 3, startLine: 3, endLine: 3 }]);
  });

  it("has nothing to run in a script of comments and blanks", () => {
    expect(splitSqlScript("-- nothing\n/* here */\n;\n")).toEqual([]);
  });
});

describe("lineOfPosition", () => {
  const statement = { sql: "-- why\nSELECT id,\n  statuss\nFROM t", firstLine: 10 };

  it("turns a server's character position into the script line it is on", () => {
    expect(lineOfPosition(statement, 1)).toBe(10);
    expect(lineOfPosition(statement, statement.sql.indexOf("SELECT") + 1)).toBe(11);
    expect(lineOfPosition(statement, statement.sql.indexOf("statuss") + 1)).toBe(12);
    expect(lineOfPosition(statement, statement.sql.indexOf("FROM") + 1)).toBe(13);
  });

  it("stays on the statement's own lines for a position past its end", () => {
    expect(lineOfPosition(statement, 10_000)).toBe(13);
    expect(lineOfPosition(statement, 0)).toBe(10);
  });
});
