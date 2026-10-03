/**
 * DBGate's Generate SQL from data, as `generateSql` writes it: a statement for each row, the values
 * as the grid shows them now and the row found by what the database holds; none at all — with the
 * reason — where an UPDATE or DELETE would have no condition, or a row is not in the database yet.
 */
import { describe, expect, it } from "bun:test";
import type { ColumnKind } from "../../../src/shared/db-column-kind";
import {
  GENERATED_SQL_MAX_CHARS, PREVIEW_STATEMENTS, STATEMENT_TYPES, generateSql, takesValues, takesWhere, type SqlSourceRow,
} from "../../../src/web/components/database/grid/generate-sql";

const KINDS = new Map<string, ColumnKind>([["id", "number"], ["qty", "number"], ["note", "text"], ["paid", "boolean"]]);
const PG = { table: "orders", schema: "public", dialect: "postgres" as const, kinds: KINDS };
const saved = (now: Record<string, unknown>, stored = now): SqlSourceRow => ({ now, stored, isNew: false });
const fresh = (now: Record<string, unknown>): SqlSourceRow => ({ now, stored: now, isNew: true });

describe("the statements", () => {
  it("INSERTs the value columns, in the order given, each value as its column spells it", () => {
    expect(generateSql("INSERT", [saved({ id: 1, qty: "12", note: "it's" })], ["id", "qty", "note"], ["id"], PG)).toEqual({
      ok: true, overLimit: false,
      statements: [`INSERT INTO "public"."orders" ("id", "qty", "note") VALUES (1, 12, 'it''s');`],
    });
    // Digits are written bare only in a number column.
    expect(generateSql("INSERT", [saved({ note: "12" })], ["note"], [], PG)).toMatchObject({
      statements: [`INSERT INTO "public"."orders" ("note") VALUES ('12');`],
    });
  });

  it("UPDATEs a row found by what the database holds, set to what the grid shows now", () => {
    const row = saved({ id: 7, qty: 5, note: null }, { id: 3, qty: 1, note: null });
    expect(generateSql("UPDATE", [row], ["id", "qty"], ["id"], PG)).toMatchObject({
      ok: true, statements: [`UPDATE "public"."orders" SET "id"=7, "qty"=5 WHERE "id"=3;`],
    });
    // A NULL is found with IS NULL; two WHERE columns are both required.
    expect(generateSql("UPDATE", [row], ["qty"], ["id", "note"], PG)).toMatchObject({
      statements: [`UPDATE "public"."orders" SET "qty"=5 WHERE "id"=3 AND "note" IS NULL;`],
    });
  });

  it("DELETEs by the WHERE columns alone, with no value column needed", () => {
    expect(generateSql("DELETE", [saved({ id: 1 }), saved({ id: 9 }, { id: 2 })], [], ["id"], PG)).toEqual({
      ok: true, overLimit: false,
      statements: [`DELETE FROM "public"."orders" WHERE "id"=1;`, `DELETE FROM "public"."orders" WHERE "id"=2;`],
    });
  });

  it("writes each engine's own quoting, booleans and table name", () => {
    expect(generateSql("INSERT", [saved({ id: 1, paid: true })], ["id", "paid"], [], { ...PG, dialect: "mysql" })).toMatchObject({
      statements: ["INSERT INTO `orders` (`id`, `paid`) VALUES (1, TRUE);"],
    });
    expect(generateSql("UPDATE", [saved({ id: 2, paid: true })], ["paid"], ["id"], { ...PG, dialect: "sqlite", schema: undefined })).toMatchObject({
      statements: [`UPDATE "orders" SET "paid"=1 WHERE "id"=2;`],
    });
    expect(generateSql("UPDATE", [saved({ id: 2, paid: false })], ["paid"], ["id"], PG)).toMatchObject({
      statements: [`UPDATE "public"."orders" SET "paid"=FALSE WHERE "id"=2;`],
    });
  });
});

describe("new rows", () => {
  it("INSERTs only the columns a new row was given something in", () => {
    expect(generateSql("INSERT", [fresh({ id: undefined, qty: 3, note: undefined })], ["id", "qty", "note"], ["id"], PG)).toMatchObject({
      ok: true, statements: [`INSERT INTO "public"."orders" ("qty") VALUES (3);`],
    });
  });

  it("writes no UPDATE or DELETE for one, and the others' all the same", () => {
    const rows = [fresh({ id: undefined, qty: 3 }), saved({ id: 4, qty: 1 })];
    expect(generateSql("UPDATE", rows, ["qty"], ["id"], PG)).toMatchObject({ statements: [`UPDATE "public"."orders" SET "qty"=1 WHERE "id"=4;`] });
    expect(generateSql("DELETE", rows, [], ["id"], PG)).toMatchObject({ statements: [`DELETE FROM "public"."orders" WHERE "id"=4;`] });
    expect(generateSql("UPDATE", [rows[0]!], ["qty"], ["id"], PG)).toEqual({
      ok: false, reason: "New rows are not in the database yet: no UPDATE or DELETE can find them",
    });
  });
});

describe("what it refuses", () => {
  const rows = [saved({ id: 1, qty: 2 })];
  it("an INSERT or UPDATE with no value column", () => {
    for (const type of ["INSERT", "UPDATE"] as const) {
      expect(generateSql(type, rows, [], ["id"], PG)).toEqual({ ok: false, reason: "Tick a value column" });
    }
  });

  it("an UPDATE or DELETE with no WHERE column, which would reach every row of the table", () => {
    for (const type of ["UPDATE", "DELETE"] as const) {
      expect(generateSql(type, rows, ["qty"], [], PG)).toEqual({
        ok: false, reason: "Tick a WHERE column: without one, the statement would reach every row of the table",
      });
    }
    // An INSERT has none to need.
    expect(generateSql("INSERT", rows, ["qty"], [], PG).ok).toBe(true);
  });

  it("no rows, or no value in the columns ticked", () => {
    expect(generateSql("DELETE", [], [], ["id"], PG)).toEqual({ ok: false, reason: "Select the rows to write SQL for" });
    expect(generateSql("INSERT", [fresh({ id: undefined, qty: undefined })], ["qty"], [], PG)).toEqual({
      ok: false, reason: "No row selected holds a value in the columns ticked",
    });
    // One new row, one saved row with nothing in the column: not every row was a new one.
    expect(generateSql("UPDATE", [fresh({ qty: 1 }), saved({ id: 2, qty: undefined })], ["qty"], ["id"], PG)).toEqual({
      ok: false, reason: "No row selected holds a value in the columns ticked",
    });
  });
});

describe("how much it writes", () => {
  /** Rows counted as they are read. */
  function counted(n: number) {
    const read = { count: 0 };
    const rows: Iterable<SqlSourceRow> = {
      *[Symbol.iterator]() {
        for (let i = 1; i <= n; i++) {
          read.count += 1;
          yield saved({ id: i });
        }
      },
    };
    return { rows, read };
  }
  const T = { table: "t", dialect: "sqlite" as const };

  it("stops once the text, a statement a line, passes the limit — not reading the rows past it", () => {
    // `DELETE FROM "t" WHERE "id"=1;` is 29 characters: two of them and the line break between, 59.
    const two = generateSql("DELETE", counted(2).rows, [], ["id"], T, 59);
    expect(two).toMatchObject({ ok: true, overLimit: false });
    expect(two.ok && two.statements.join("\n").length).toBe(59);
    const { rows, read } = counted(5);
    expect(generateSql("DELETE", rows, [], ["id"], T, 58)).toMatchObject({ ok: true, overLimit: true, statements: { length: 2 } });
    expect(read.count).toBe(2);
    expect(generateSql("DELETE", counted(5).rows, [], ["id"], T)).toMatchObject({ overLimit: false, statements: { length: 5 } });
  });

  it("keeps a Query tab's text to a quarter of a million characters, and previews 200 statements", () => {
    expect([GENERATED_SQL_MAX_CHARS, PREVIEW_STATEMENTS]).toEqual([250_000, 200]);
  });
});

it("offers DBGate's query types in its order, each with the lists it uses", () => {
  expect(STATEMENT_TYPES).toEqual(["INSERT", "UPDATE", "DELETE"]);
  expect(STATEMENT_TYPES.map((t) => [takesValues(t), takesWhere(t)])).toEqual([[true, false], [true, true], [false, true]]);
});
