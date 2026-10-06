import { describe, expect, it } from "bun:test";
import { FORMAT_MAX_CHARS, formatSqlScript } from "../../../src/web/components/database/query/format-sql";
import { cursorAfterReformat } from "../../../src/web/components/database/reformat-cursor";

function errorOf(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("did not throw");
}

describe("Format SQL", () => {
  it("lays the script out, keyword case as typed", () => {
    expect(formatSqlScript("select a,b from t where x=1;SELECT 2", "postgres"))
      .toBe("select\n  a,\n  b\nfrom\n  t\nwhere\n  x = 1;\n\nSELECT\n  2");
  });

  it("reads each engine's own SQL", () => {
    // A cast only Postgres has, which the SQLite dialect refuses.
    expect(formatSqlScript("select x::int from t", "postgres")).toBe("select\n  x::int\nfrom\n  t");
    expect(errorOf(() => formatSqlScript("select x::int from t", "sqlite"))).toStartWith("Parse error");
    // RETURNING is a clause in MariaDB and nothing to MySQL.
    expect(formatSqlScript("delete from t returning id", "mariadb")).toBe("delete from t\nreturning\n  id");
    expect(formatSqlScript("delete from t returning id", "mysql")).toBe("delete from t returning id");
  });

  it("keeps the line breaks around the script, and leaves blank text alone", () => {
    expect(formatSqlScript("\n\nselect 1  \n", "postgres")).toBe("\n\nselect\n  1\n");
    expect(formatSqlScript("  \n ", "postgres")).toBe("  \n ");
  });

  it("formats a MySQL script between its DELIMITER lines, keeping them and the procedure body as typed", () => {
    const script = [
      "select a,b from t;",
      "",
      "DELIMITER //",
      "create procedure p() begin select 1; select 2; end //",
      "DELIMITER ;",
      "select 3",
      "",
    ].join("\n");
    const formatted = "select\n  a,\n  b\nfrom\n  t;\n\nDELIMITER //\ncreate procedure p() begin select 1; select 2; end //\nDELIMITER ;\nselect\n  3\n";
    expect(formatSqlScript(script, "mysql")).toBe(formatted);
    expect(formatSqlScript(script, "mariadb")).toBe(formatted);
  });

  it("says what it could not read in one line, on the editor's line", () => {
    expect(errorOf(() => formatSqlScript("select 1;\n\nselect )", "postgres"))).toBe("Parse error at token: ) at line 3 column 8");
    const script = ["DELIMITER //", "create procedure p() begin select 1; end //", "DELIMITER ;", "", "select )"].join("\n");
    expect(errorOf(() => formatSqlScript(script, "mysql"))).toBe("Parse error at token: ) at line 5 column 8");
  });

  it(`takes on a script of up to ${FORMAT_MAX_CHARS.toLocaleString("en-US")} characters`, () => {
    expect(formatSqlScript(" ".repeat(FORMAT_MAX_CHARS), "postgres")).toBe(" ".repeat(FORMAT_MAX_CHARS));
    expect(errorOf(() => formatSqlScript(" ".repeat(FORMAT_MAX_CHARS + 1), "postgres")))
      .toBe("The script is longer than 500,000 characters.");
  });
});

describe("the cursor after Format", () => {
  const before = "select a,b from t where x=1";
  const after = "select\n  a,\n  b\nfrom\n  t\nwhere\n  x = 1";

  it("stays just past the character it followed", () => {
    expect(cursorAfterReformat(before, after, { lineNumber: 1, column: 16 })).toEqual({ lineNumber: 4, column: 5 });
    expect(cursorAfterReformat(before, after, { lineNumber: 1, column: 14 })).toEqual({ lineNumber: 4, column: 3 });
    expect(cursorAfterReformat(before, after, { lineNumber: 1, column: 28 })).toEqual({ lineNumber: 7, column: 8 });
  });

  it("stays in front of the character it was in front of, after a blank", () => {
    expect(cursorAfterReformat(before, after, { lineNumber: 1, column: 17 })).toEqual({ lineNumber: 5, column: 3 });
    expect(cursorAfterReformat(before, after, { lineNumber: 1, column: 1 })).toEqual({ lineNumber: 1, column: 1 });
  });

  it("counts the lines above the cursor", () => {
    const [two, laidOut] = ["select 1;\nselect  2", "select\n  1;\n\nselect\n  2"];
    expect(cursorAfterReformat(two, laidOut, { lineNumber: 2, column: 9 })).toEqual({ lineNumber: 5, column: 3 });
    expect(cursorAfterReformat(two, laidOut, { lineNumber: 2, column: 7 })).toEqual({ lineNumber: 4, column: 7 });
  });
});
