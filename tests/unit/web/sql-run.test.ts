import { describe, expect, it } from "bun:test";
import { scriptRun, selectionOrStatementRun, statementRun } from "../../../src/web/components/database/sql-run";

const script = ["SELECT 1;", "", "-- the second", "UPDATE t", "SET a = 1;", "SELECT 3"].join("\n");

describe("what the Query tab's keys send", () => {
  it("F5 sends the selection, from where it begins, else the whole script", () => {
    expect(scriptRun(script, { text: "UPDATE t\nSET a = 1;", startLine: 4 })).toEqual({ sql: "UPDATE t\nSET a = 1;", lineOffset: 3, from: "selection" });
    expect(scriptRun(script, { text: " \n ", startLine: 2 })).toEqual({ sql: script, lineOffset: 0, from: "script" });
    expect(scriptRun(script, null)).toEqual({ sql: script, lineOffset: 0, from: "script" });
    expect(scriptRun("  \n-- ", null)).toEqual({ sql: "  \n-- ", lineOffset: 0, from: "script" });
    expect(scriptRun(" \n ", null)).toBeNull();
  });

  it("Ctrl+Enter sends the statement the cursor is in, from its own first line", () => {
    expect(statementRun(script, 5, "postgres")).toEqual({ sql: "UPDATE t\nSET a = 1;", lineOffset: 3, from: "statement" });
    // Between statements, the one below.
    expect(statementRun(script, 2, "postgres")).toMatchObject({ sql: "UPDATE t\nSET a = 1;", lineOffset: 3 });
    expect(statementRun(script, 6, "postgres")).toMatchObject({ sql: "SELECT 3", lineOffset: 5 });
    expect(statementRun("-- nothing here", 1, "postgres")).toBeNull();
  });

  it("counts the DELIMITER line sent in front of a MySQL procedure", () => {
    const mysql = ["-- setup", "DELIMITER //", "CREATE PROCEDURE p()", "BEGIN", "  SELECT 1;", "END //", "DELIMITER ;", "CALL p();"].join("\n");
    const run = statementRun(mysql, 4, "mysql")!;
    expect(run.sql.split("\n")[0]).toBe("DELIMITER //");
    // Line 2 of what is sent is the procedure's first line, the editor's line 3.
    expect(run.lineOffset).toBe(1);
  });

  it("Explain sends the selection, else the statement at the cursor", () => {
    expect(selectionOrStatementRun(script, { text: "SELECT 3", startLine: 6 }, 1, "postgres")).toEqual({ sql: "SELECT 3", lineOffset: 5, from: "selection" });
    expect(selectionOrStatementRun(script, null, 1, "postgres")).toEqual({ sql: "SELECT 1;", lineOffset: 0, from: "statement" });
    expect(selectionOrStatementRun(script, { text: "  ", startLine: 1 }, 4, "postgres")).toMatchObject({ sql: "UPDATE t\nSET a = 1;", from: "statement" });
  });
});
