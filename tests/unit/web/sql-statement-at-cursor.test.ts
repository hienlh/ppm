import { describe, it, expect } from "bun:test";
import { getStatementAtCursor } from "../../../src/web/components/database/sql-query-editor";

describe("getStatementAtCursor", () => {
  it("returns the only statement when no semicolons", () => {
    expect(getStatementAtCursor("SELECT * FROM users", 1)).toBe("SELECT * FROM users");
  });

  it("returns first statement when cursor is on line 1", () => {
    const text = "SELECT * FROM users;\nSELECT * FROM orders;";
    expect(getStatementAtCursor(text, 1)).toBe("SELECT * FROM users;");
  });

  it("returns second statement when cursor is on line 2", () => {
    const text = "SELECT * FROM users;\nSELECT * FROM orders;";
    expect(getStatementAtCursor(text, 2)).toBe("SELECT * FROM orders;");
  });

  it("handles multiline statements", () => {
    const text = "SELECT *\nFROM users\nWHERE id = 1;\nSELECT 1;";
    expect(getStatementAtCursor(text, 2)).toBe("SELECT *\nFROM users\nWHERE id = 1;");
  });

  it("skips leading empty lines", () => {
    const text = "\n\nSELECT * FROM users;";
    expect(getStatementAtCursor(text, 3)).toBe("SELECT * FROM users;");
  });

  it("skips leading comment lines", () => {
    const text = "-- this is a comment\nSELECT * FROM users;";
    expect(getStatementAtCursor(text, 2)).toBe("SELECT * FROM users;");
  });

  it("returns statement without trailing semicolon boundary", () => {
    const text = "SELECT * FROM users;\nSELECT * FROM orders";
    // cursor on line 2, no trailing semicolon — should return up to end
    expect(getStatementAtCursor(text, 2)).toBe("SELECT * FROM orders");
  });

  it("handles cursor in middle of multiline statement", () => {
    const text = "SELECT 1;\nSELECT *\nFROM users\nWHERE id = 1;\nSELECT 2;";
    // cursor on line 3 (FROM users) — should return the second statement
    expect(getStatementAtCursor(text, 3)).toBe("SELECT *\nFROM users\nWHERE id = 1;");
  });

  it("handles empty input", () => {
    expect(getStatementAtCursor("", 1)).toBe("");
  });

  it("handles single semicolon", () => {
    expect(getStatementAtCursor(";", 1)).toBe(";");
  });
});
