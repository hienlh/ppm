import { describe, expect, it } from "bun:test";
import {
  delimiterDirectives, getStatementAtCursor, runLineOffset, splitSqlStatements, splitSqlStatementsWithLines, sqlCode, statementAtCursor,
} from "../../../../src/shared/split-sql-statements.ts";

describe("splitSqlStatements (server)", () => {
  it("splits at semicolons and drops empty statements", () => {
    expect(splitSqlStatements("SELECT 1; ;SELECT 2;\n")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("drops a statement made only of comments", () => {
    expect(splitSqlStatements("SELECT 1; -- done\n/* really */")).toEqual(["SELECT 1"]);
    expect(splitSqlStatements("-- a;\nSELECT 1")).toEqual(["-- a;\nSELECT 1"]);
  });

  it("does not split inside strings or quoted names", () => {
    expect(splitSqlStatements(`SELECT ';', "a;b"; SELECT 2`)).toEqual([`SELECT ';', "a;b"`, "SELECT 2"]);
    expect(splitSqlStatements(`SELECT 'it''s; fine'; SELECT 2`)).toEqual([`SELECT 'it''s; fine'`, "SELECT 2"]);
  });

  it("reads Postgres escape strings, and plain strings where a backslash is just a character", () => {
    expect(splitSqlStatements(String.raw`SELECT E'it\'s; fine'; SELECT 2`)).toEqual([String.raw`SELECT E'it\'s; fine'`, "SELECT 2"]);
    expect(splitSqlStatements(String.raw`SELECT 'a\'; SELECT 2`)).toEqual([String.raw`SELECT 'a\'`, "SELECT 2"]);
    // `aE'…'` is an identifier followed by a plain string, not an escape string.
    expect(splitSqlStatements(String.raw`SELECT aE'x\'; SELECT 2`)).toEqual([String.raw`SELECT aE'x\'`, "SELECT 2"]);
  });

  it("keeps a dollar-quoted body whole, and does not take a parameter for one", () => {
    const fn = "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql";
    expect(splitSqlStatements(`${fn}; SELECT 2`)).toEqual([fn, "SELECT 2"]);
    expect(splitSqlStatements("SELECT $$a;b$$; SELECT 2")).toEqual(["SELECT $$a;b$$", "SELECT 2"]);
    expect(splitSqlStatements("SELECT $1; SELECT $2")).toEqual(["SELECT $1", "SELECT $2"]);
    expect(splitSqlStatements("SELECT a$b; SELECT 2")).toEqual(["SELECT a$b", "SELECT 2"]);
  });

  it("nests block comments in Postgres and not in SQLite", () => {
    expect(splitSqlStatements("/* a /* b */ ; */ SELECT 1", "postgres")).toEqual(["/* a /* b */ ; */ SELECT 1"]);
    expect(splitSqlStatements("/* a /* b */ ; */ SELECT 1", "sqlite")).toEqual(["*/ SELECT 1"]);
  });

  it("reads SQLite's backtick and bracket names", () => {
    expect(splitSqlStatements("SELECT `a;b`, [c;d] FROM t; SELECT 2", "sqlite")).toEqual(["SELECT `a;b`, [c;d] FROM t", "SELECT 2"]);
  });
});

describe("sqlCode", () => {
  it("leaves only code: comments go, strings and names are emptied", () => {
    expect(sqlCode(`SELECT 'DELETE' -- DROP\nFROM "UPDATE" /* ALTER */`).replace(/\s+/g, " ").trim()).toBe(`SELECT '' FROM ""`);
  });
});

describe("splitSqlStatements (MySQL)", () => {
  const my = (sql: string) => splitSqlStatements(sql, "mysql");

  it("keeps backticked names and # comments whole", () => {
    expect(my("SELECT `a;b` FROM t; SELECT 2")).toEqual(["SELECT `a;b` FROM t", "SELECT 2"]);
    expect(my("SELECT 1 # ; not the end\n, 2; SELECT 3")).toEqual(["SELECT 1 # ; not the end\n, 2", "SELECT 3"]);
  });

  it("reads -- as a comment only when a blank follows, as MySQL does", () => {
    expect(my("SELECT 1--1; SELECT 2")).toEqual(["SELECT 1--1", "SELECT 2"]);
    expect(my("SELECT 1 -- ; x\n; SELECT 2")).toEqual(["SELECT 1 -- ; x", "SELECT 2"]);
    expect(splitSqlStatements("SELECT 1--1; SELECT 2", "postgres")).toEqual(["SELECT 1--1; SELECT 2"]);
  });

  it("ends a string at an escaped quote only while backslashes escape", () => {
    expect(my(String.raw`SELECT 'a\'; b'; SELECT 2`)).toEqual([String.raw`SELECT 'a\'; b'`, "SELECT 2"]);
    expect(my(String.raw`SELECT "a\"; b"; SELECT 2`)).toEqual([String.raw`SELECT "a\"; b"`, "SELECT 2"]);
    expect(splitSqlStatements(String.raw`SELECT 'a\'; b'; SELECT 2`, "mysql", { backslashEscapes: false }))
      .toEqual([String.raw`SELECT 'a\'`, "b'; SELECT 2"]);
  });

  it("splits a DELIMITER script into its two statements, not four", () => {
    const script = [
      "DELIMITER //",
      "CREATE PROCEDURE p()",
      "BEGIN",
      "  SELECT 1;",
      "  SELECT 2;",
      "END //",
      "DELIMITER ;",
      "CALL p();",
    ].join("\n");
    expect(my(script)).toEqual(["CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND", "CALL p()"]);
    expect(my("delimiter $$\nSELECT 1; SELECT 2 $$\nSELECT 3 $$")).toEqual(["SELECT 1; SELECT 2", "SELECT 3"]);
  });

  it("reads DELIMITER only at the start of a line between statements, and only in MySQL", () => {
    expect(my("SELECT 1\nDELIMITER //")).toEqual(["SELECT 1\nDELIMITER //"]);
    expect(splitSqlStatements("DELIMITER //\nSELECT 1 //", "postgres")).toEqual(["DELIMITER //\nSELECT 1 //"]);
  });

  it("keeps an executable comment as a statement of its own", () => {
    expect(my("/*!40101 SET NAMES utf8 */; SELECT 1")).toEqual(["/*!40101 SET NAMES utf8 */", "SELECT 1"]);
    expect(splitSqlStatements("/*!40101 SET NAMES utf8 */; SELECT 1", "postgres")).toEqual(["SELECT 1"]);
  });
});

describe("delimiterDirectives", () => {
  it("finds the DELIMITER lines the mysql client reads, and the terminator each sets", () => {
    const text = ["DELIMITER //", "SELECT 'DELIMITER ;' //", "-- DELIMITER $$", "  delimiter ;"].join("\n");
    expect(delimiterDirectives(text, "mysql")).toEqual([
      { start: 0, end: 12, delimiter: "//" },
      { start: text.lastIndexOf("delimiter"), end: text.length, delimiter: ";" },
    ]);
  });

  it("finds none after an unfinished statement, or outside MySQL", () => {
    expect(delimiterDirectives("SELECT 1\nDELIMITER //", "mysql")).toEqual([]);
    expect(delimiterDirectives("DELIMITER //\nSELECT 1 //", "postgres")).toEqual([]);
  });
});

describe("splitSqlStatementsWithLines (MySQL)", () => {
  const script = [
    "-- setup",
    "DELIMITER //",
    "CREATE PROCEDURE p()",
    "BEGIN",
    "  SELECT 1;",
    "END //",
    "DELIMITER ;",
    "CALL p();",
  ].join("\n");

  it("places each statement where it is typed and skips the DELIMITER lines", () => {
    const statements = splitSqlStatementsWithLines(script, "mysql");
    expect(statements.map((s) => [s.startLine, s.endLine])).toEqual([[3, 6], [8, 8]]);
    expect(statements[0]!.sql).toBe("CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND //");
    expect(statements[1]).toMatchObject({ sql: "CALL p();", run: "CALL p();" });
  });

  it("runs a delimited statement with its DELIMITER, so the server splits it the same way", () => {
    const run = getStatementAtCursor(script, 4, "mysql");
    expect(run).toBe("DELIMITER //\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND\n//");
    expect(splitSqlStatements(run, "mysql")).toEqual(["CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND"]);
  });

  it("maps a line of what runs back to the script's, the DELIMITER line sent in front included", () => {
    // Line 2 of what is sent, the procedure's first, is line 3 of the script.
    expect(runLineOffset(statementAtCursor(script, 4, "mysql")!)).toBe(1);
    expect(runLineOffset(statementAtCursor(script, 8, "mysql")!)).toBe(7);
  });
});
