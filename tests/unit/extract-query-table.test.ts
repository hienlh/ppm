import { describe, it, expect } from "bun:test";
import { extractQueryTable } from "../../src/web/components/database/extract-query-table";

describe("extractQueryTable", () => {
  it("resolves a plain single-table select", () => {
    expect(extractQueryTable('SELECT * FROM "self_bill" WHERE "id" = \'SFB-1\'', "public"))
      .toEqual({ table: "self_bill", schema: "public" });
  });

  it("resolves an unquoted table and an alias", () => {
    expect(extractQueryTable("select * from self_bill sb where sb.id = 1", "public"))
      .toEqual({ table: "self_bill", schema: "public" });
  });

  it("keeps an explicit schema qualifier over the default", () => {
    expect(extractQueryTable('SELECT * FROM "billing"."self_bill"', "public"))
      .toEqual({ table: "self_bill", schema: "billing" });
    expect(extractQueryTable("SELECT * FROM billing.self_bill", "public"))
      .toEqual({ table: "self_bill", schema: "billing" });
  });

  it("falls back to the caller's schema when the query has none", () => {
    expect(extractQueryTable('SELECT * FROM "self_bill"', "umbrella"))
      .toEqual({ table: "self_bill", schema: "umbrella" });
  });

  it("tolerates comments and a trailing semicolon", () => {
    expect(extractQueryTable('-- find the bill\nSELECT * FROM "self_bill";', "public"))
      .toEqual({ table: "self_bill", schema: "public" });
    expect(extractQueryTable('/* block */ SELECT * FROM "self_bill"', "public"))
      .toEqual({ table: "self_bill", schema: "public" });
  });

  it("refuses queries whose rows map to more than one table", () => {
    const ambiguous = [
      'SELECT * FROM "a" JOIN "b" ON a.id = b.a_id',
      'SELECT * FROM "a" UNION SELECT * FROM "b"',
      'SELECT * FROM (SELECT * FROM "a") t',
      'SELECT count(*) FROM "a" GROUP BY "x"',
      'SELECT DISTINCT "x" FROM "a"',
      'SELECT * FROM "a" WHERE id IN (SELECT id FROM "b")',
    ];
    for (const sql of ambiguous) expect(extractQueryTable(sql, "public")).toBeNull();
  });

  it("refuses anything that is not a select", () => {
    expect(extractQueryTable('UPDATE "self_bill" SET x = 1', "public")).toBeNull();
    expect(extractQueryTable('DELETE FROM "self_bill"', "public")).toBeNull();
    expect(extractQueryTable('WITH t AS (SELECT 1) SELECT * FROM t', "public")).toBeNull();
    expect(extractQueryTable("SELECT 1", "public")).toBeNull();
  });
});
