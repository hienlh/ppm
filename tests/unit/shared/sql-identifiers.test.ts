import { describe, expect, it } from "bun:test";
import { quoteIdentifier, quoteLiteral, sqlLiteral } from "../../../src/shared/sql-identifiers.ts";
import { mysqlDialect } from "../../../src/services/database/dialect-mysql.ts";
import { postgresDialect } from "../../../src/services/database/dialect-postgres.ts";
import { sqliteDialect } from "../../../src/services/database/dialect-sqlite.ts";

/**
 * The browser writes a handful of statements itself (a table's first query, the query a
 * foreign key opens); they must quote exactly as the server's dialects do.
 */
describe("the browser's quoting matches the server's dialects", () => {
  const names = ["users", "Order Items", 'say "hi"', "back`tick"];
  const values = ["plain", "it's", "C:\\temp\\", "a\\'b"];

  for (const d of [postgresDialect, sqliteDialect, mysqlDialect]) {
    it(`on ${d.name}`, () => {
      for (const n of names) expect(quoteIdentifier(n, d.name)).toBe(d.quoteIdent(n));
      for (const v of values) expect(quoteLiteral(v, d.name)).toBe(d.literal(v));
    });
  }

  it("never writes a MySQL identifier in double quotes, which MySQL reads as a string", () => {
    expect(quoteIdentifier("users", "mysql")).toBe("`users`");
  });
});

/**
 * Copy as SQL and Generate SQL write values the server sent as JSON; they must read exactly as the
 * server's own `literal()` writes the same value, bytes included.
 */
describe("a value the grid holds, written as a literal", () => {
  const bytes = new Uint8Array([0, 1, 0xab, 0xff]);
  const sent = { $binary: Buffer.from(bytes).toString("base64"), size: bytes.length };
  const values: unknown[] = [null, true, false, 0, -12.5, 1e21, "plain", "it's", "C:\\temp\\", "", { a: "it's", b: [1, "\\"] }, [1, 2]];

  for (const d of [postgresDialect, sqliteDialect, mysqlDialect]) {
    it(`matches the server on ${d.name}`, () => {
      for (const v of values) expect(sqlLiteral(v, d.name)).toBe(d.literal(v));
      expect(sqlLiteral(sent, d.name)).toBe(d.literal(bytes));
      expect(sqlLiteral({ $binary: "", size: 0 }, d.name)).toBe(d.literal(new Uint8Array()));
    });
  }

  it("writes a cell a new row was given nothing in as NULL", () => {
    expect(sqlLiteral(undefined, "postgres")).toBe("NULL");
  });

  it("writes a number column's digits bare, past 2^53 and as a DECIMAL", () => {
    expect(sqlLiteral("9007199254740993", "postgres", "number")).toBe("9007199254740993");
    expect(sqlLiteral("-0.50", "mysql", "number")).toBe("-0.50");
    expect(sqlLiteral(".5", "sqlite", "number")).toBe(".5");
    expect(sqlLiteral("1.5E+3", "postgres", "number")).toBe("1.5E+3");
    // Digits in a text column are text; anything else in a number column is not a number.
    expect(sqlLiteral("9007199254740993", "postgres", "text")).toBe("'9007199254740993'");
    expect(sqlLiteral("9007199254740993", "postgres")).toBe("'9007199254740993'");
    expect(sqlLiteral("NaN", "postgres", "number")).toBe("'NaN'");
    expect(sqlLiteral("1; DROP TABLE t", "postgres", "number")).toBe("'1; DROP TABLE t'");
    expect(sqlLiteral("12abc", "postgres", "number")).toBe("'12abc'");
    expect(sqlLiteral("abc12", "postgres", "number")).toBe("'abc12'");
  });

  it("will not write bytes the server sent only the start of", () => {
    const head = { $binary: Buffer.from(bytes).toString("base64"), size: 200_000, truncated: true };
    for (const d of ["postgres", "sqlite", "mysql"] as const) expect(sqlLiteral(head, d)).toBe("/* 200000 bytes, not loaded */");
  });
});

/**
 * A Postgres array arrives as a JSON array, and `'[1,2]'` is a "malformed array literal" to an array
 * column: Copy as SQL, Generate SQL, the SQL export and the Save dialog's script write Postgres's own
 * array text instead. A json column's array is JSON, and only the column's kind can say which it is.
 */
describe("a Postgres array, written as Postgres reads one", () => {
  const bytes = new Uint8Array([0, 1, 0xab, 0xff]);
  const sent = { $binary: Buffer.from(bytes).toString("base64"), size: bytes.length };

  it("is Postgres's array text, each element quoted and NULL left bare", () => {
    expect(sqlLiteral([1, 2], "postgres", "other")).toBe(`'{"1","2"}'`);
    expect(sqlLiteral(["a,b", 'say "hi"', "back\\slash", "{brace}", null, "NULL", "", " padded ", "it's"], "postgres", "other"))
      .toBe(`'{"a,b","say \\"hi\\"","back\\\\slash","{brace}",NULL,"NULL",""," padded ","it''s"}'`);
    expect(sqlLiteral([[1, 2], [3, null]], "postgres", "other")).toBe(`'{{"1","2"},{"3",NULL}}'`);
    expect(sqlLiteral([], "postgres", "other")).toBe("'{}'");
    expect(sqlLiteral([true, false, { k: "v" }], "postgres", "other")).toBe(`'{"true","false","{\\"k\\":\\"v\\"}"}'`);
  });

  it("writes bytes in one as Postgres's hex, and will not write bytes the server sent only the start of", () => {
    expect(sqlLiteral([sent, null], "postgres", "other")).toBe(`'{"\\\\x0001abff",NULL}'`);
    const head = { ...sent, size: 200_000, truncated: true };
    expect(sqlLiteral([[sent], [head]], "postgres", "other")).toBe("/* 200000 bytes, not loaded */");
  });

  it("leaves a json column's array as JSON, and every array on another engine", () => {
    expect(sqlLiteral([1, { k: "v" }], "postgres", "json")).toBe(`'[1,{"k":"v"}]'`);
    expect(sqlLiteral([1, 2], "mysql", "json")).toBe("'[1,2]'");
    expect(sqlLiteral([1, 2], "sqlite", "other")).toBe("'[1,2]'");
  });

  it("matches the server's literal, which writes the same arrays into a preview and an SQL export", () => {
    const pairs: [unknown[], unknown[]][] = [
      [[1, 2], [1, 2]],
      [["a,b", null, 'say "hi"'], ["a,b", null, 'say "hi"']],
      [[[1], [2]], [[1], [2]]],
      [[sent, null], [bytes, null]],
      [["9007199254740993"], [9007199254740993n]],
      [["2024-01-02T03:04:05.000Z"], [new Date("2024-01-02T03:04:05Z")]],
      [[{ k: "it's" }], [{ k: "it's" }]],
    ];
    for (const kind of ["other", undefined] as const) {
      for (const [inBrowser, inDriver] of pairs) expect(sqlLiteral(inBrowser, "postgres", kind)).toBe(postgresDialect.literal(inDriver, kind));
    }
    // A json column holds no bytes, dates or bigints: its driver values are JSON already.
    for (const [inBrowser, inDriver] of [pairs[0]!, pairs[1]!, pairs[2]!, pairs[6]!]) {
      expect(sqlLiteral(inBrowser, "postgres", "json")).toBe(postgresDialect.literal(inDriver, "json"));
    }
  });
});
