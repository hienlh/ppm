import { describe, expect, it } from "bun:test";
import type { FilterCondition, FilterGroup, GridSort } from "../../../../src/shared/db-grid.ts";
import type { DialectColumn, SqlDialect } from "../../../../src/services/database/dialect.ts";
import { postgresDialect } from "../../../../src/services/database/dialect-postgres.ts";
import { sqliteDialect } from "../../../../src/services/database/dialect-sqlite.ts";
import {
  GridRequestError, buildCount, buildDistinctValues, buildSelect, parseGridCountRequest, parseGridRequest, parseGridValuesRequest,
  rawSqlConditions,
  type ValidGridRequest, type ValidGridValuesRequest,
} from "../../../../src/services/database/grid-query-builder.ts";
import { mysqlDialect } from "../../../../src/services/database/dialect-mysql.ts";

const COLUMNS: DialectColumn[] = [
  { name: "id", type: "integer", kind: "number" },
  { name: "name", type: "text", kind: "text" },
  { name: "active", type: "boolean", kind: "boolean" },
  { name: "created", type: "timestamp without time zone", kind: "datetime" },
  { name: "at", type: "timestamp with time zone", kind: "datetimetz" },
];

function req(over: Partial<ValidGridRequest> = {}): ValidGridRequest {
  return { table: "t", schema: null, filters: [], anyColumn: [], sort: [], offset: 0, limit: 100, ...over };
}

function one(column: string, cond: FilterCondition): FilterGroup[] {
  return [{ column, anyOf: [[cond]] }];
}

/** The WHERE clause and the parameters it bound, paging stripped. */
function whereOf(d: SqlDialect, filters: FilterGroup[]): { where: string | undefined; params: unknown[] } {
  const built = buildSelect(d, COLUMNS, req({ filters }));
  return { where: built.sql.match(/\nWHERE ([\s\S]*?)\nLIMIT /)?.[1], params: built.params.slice(0, -2) };
}

const PG_ESC = `ESCAPE E'\\\\'`;
const LITE_ESC = `ESCAPE '\\'`;

/** [label, column, condition, Postgres WHERE, SQLite WHERE, params] */
const OPERATOR_CASES: [string, string, FilterCondition, string, string, unknown[]][] = [
  ["eq", "id", { op: "eq", value: 5 }, `"id" = $1`, `"id" = ?`, [5]],
  ["eq null", "id", { op: "eq", value: null }, `"id" IS NULL`, `"id" IS NULL`, []],
  ["ne", "id", { op: "ne", value: 5 }, `"id" <> $1`, `"id" <> ?`, [5]],
  ["ne null", "id", { op: "ne", value: null }, `"id" IS NOT NULL`, `"id" IS NOT NULL`, []],
  ["gt", "id", { op: "gt", value: 5 }, `"id" > $1`, `"id" > ?`, [5]],
  ["ge", "id", { op: "ge", value: 5 }, `"id" >= $1`, `"id" >= ?`, [5]],
  ["lt", "id", { op: "lt", value: 5 }, `"id" < $1`, `"id" < ?`, [5]],
  ["le", "id", { op: "le", value: 5 }, `"id" <= $1`, `"id" <= ?`, [5]],
  ["contains", "name", { op: "contains", value: "ab" }, `"name" ILIKE $1 ${PG_ESC}`, `"name" LIKE ? ${LITE_ESC}`, ["%ab%"]],
  ["contains on a number", "id", { op: "contains", value: "12" }, `CAST("id" AS TEXT) ILIKE $1 ${PG_ESC}`, `"id" LIKE ? ${LITE_ESC}`, ["%12%"]],
  ["contains a wildcard", "name", { op: "contains", value: "5%_" }, `"name" ILIKE $1 ${PG_ESC}`, `"name" LIKE ? ${LITE_ESC}`, ["%5\\%\\_%"]],
  ["notContains", "name", { op: "notContains", value: "ab" }, `NOT ("name" ILIKE $1 ${PG_ESC})`, `NOT ("name" LIKE ? ${LITE_ESC})`, ["%ab%"]],
  ["startsWith", "name", { op: "startsWith", value: "ab" }, `"name" ILIKE $1 ${PG_ESC}`, `"name" LIKE ? ${LITE_ESC}`, ["ab%"]],
  ["notStartsWith", "name", { op: "notStartsWith", value: "ab" }, `NOT ("name" ILIKE $1 ${PG_ESC})`, `NOT ("name" LIKE ? ${LITE_ESC})`, ["ab%"]],
  ["endsWith", "name", { op: "endsWith", value: "ab" }, `"name" ILIKE $1 ${PG_ESC}`, `"name" LIKE ? ${LITE_ESC}`, ["%ab"]],
  ["notEndsWith", "name", { op: "notEndsWith", value: "ab" }, `NOT ("name" ILIKE $1 ${PG_ESC})`, `NOT ("name" LIKE ? ${LITE_ESC})`, ["%ab"]],
  ["isNull", "name", { op: "isNull" }, `"name" IS NULL`, `"name" IS NULL`, []],
  ["notNull", "name", { op: "notNull" }, `"name" IS NOT NULL`, `"name" IS NOT NULL`, []],
  ["isEmpty", "name", { op: "isEmpty" }, `("name" IS NULL OR TRIM("name") = '')`, `("name" IS NULL OR TRIM("name") = '')`, []],
  ["isEmpty on a number", "id", { op: "isEmpty" }, `("id" IS NULL OR TRIM(CAST("id" AS TEXT)) = '')`, `("id" IS NULL OR TRIM("id") = '')`, []],
  ["notEmpty", "name", { op: "notEmpty" }, `("name" IS NOT NULL AND TRIM("name") <> '')`, `("name" IS NOT NULL AND TRIM("name") <> '')`, []],
  ["isTrue", "active", { op: "isTrue" }, `"active" = TRUE`, `"active" = 1`, []],
  ["isFalse", "active", { op: "isFalse" }, `"active" = FALSE`, `"active" = 0`, []],
  ["in", "id", { op: "in", values: [1, 2] }, `"id" IN ($1, $2)`, `"id" IN (?, ?)`, [1, 2]],
  ["in with null", "id", { op: "in", values: [1, null] }, `("id" IN ($1) OR "id" IS NULL)`, `("id" IN (?) OR "id" IS NULL)`, [1]],
  ["in only null", "id", { op: "in", values: [null] }, `"id" IS NULL`, `"id" IS NULL`, []],
  ["dateRange", "created", { op: "dateRange", from: "2024-02-15", to: "2024-02-16" },
    `("created" >= $1 AND "created" < $2)`, `(strftime('%Y-%m-%d %H:%M:%f', "created") >= ? AND strftime('%Y-%m-%d %H:%M:%f', "created") < ?)`, ["2024-02-15", "2024-02-16"]],
  ["dateRange from only", "created", { op: "dateRange", from: "2024-02-15 10:00" },
    `"created" >= $1`, `strftime('%Y-%m-%d %H:%M:%f', "created") >= ?`, ["2024-02-15 10:00"]],
  ["rawSql", "id", { op: "rawSql", sql: "$$ > 5 OR $$ IS NULL" }, `(\n"id" > 5 OR "id" IS NULL\n)`, `(\n"id" > 5 OR "id" IS NULL\n)`, []],
];

describe("buildSelect: every operator in every dialect", () => {
  for (const [label, column, cond, pg, lite, params] of OPERATOR_CASES) {
    it(label, () => {
      expect(whereOf(postgresDialect, one(column, cond))).toEqual({ where: pg, params });
      expect(whereOf(sqliteDialect, one(column, cond))).toEqual({ where: lite, params });
    });
  }

  it("puts the user's zone on a timestamptz bound and not on a timestamp", () => {
    const range = { op: "dateRange" as const, from: "2024-02-15 00:00:00", offset: "+07:00" };
    expect(whereOf(postgresDialect, one("at", range)).params).toEqual(["2024-02-15 00:00:00+07:00"]);
    expect(whereOf(postgresDialect, one("created", range)).params).toEqual(["2024-02-15 00:00:00"]);
  });
});

describe("buildSelect: combining conditions", () => {
  it("reads one column's groups as an OR of ANDs", () => {
    const filters: FilterGroup[] = [{
      column: "name",
      anyOf: [[{ op: "contains", value: "canada" }, { op: "contains", value: "lake" }], [{ op: "contains", value: "usa" }]],
    }];
    expect(whereOf(sqliteDialect, filters)).toEqual({
      where: `(("name" LIKE ? ${LITE_ESC} AND "name" LIKE ? ${LITE_ESC}) OR "name" LIKE ? ${LITE_ESC})`,
      params: ["%canada%", "%lake%", "%usa%"],
    });
  });

  it("joins different columns with AND", () => {
    const filters: FilterGroup[] = [...one("id", { op: "gt", value: 1 }), ...one("name", { op: "isNull" })];
    expect(whereOf(postgresDialect, filters).where).toBe(`"id" > $1\nAND "name" IS NULL`);
  });

  it("ORs the Multi column filter's columns and ANDs the result with the column filters", () => {
    const built = buildSelect(postgresDialect, COLUMNS, req({
      filters: one("id", { op: "gt", value: 1 }),
      anyColumn: [...one("name", { op: "contains", value: "x" }), ...one("id", { op: "eq", value: 2 })],
    }));
    expect(built.sql.match(/\nWHERE ([\s\S]*?)\nLIMIT /)?.[1]).toBe(`"id" > $1\nAND ("name" ILIKE $2 ${PG_ESC}\nOR "id" = $3)`);
    expect(built.params.slice(0, 3)).toEqual([1, "%x%", 2]);
    expect(built.displaySql).toContain(`WHERE "id" > 1\nAND ("name" ILIKE '%x%' ${PG_ESC}\nOR "id" = 2)`);
  });

  it("needs no parentheses for a Multi column filter only one column can read", () => {
    const built = buildSelect(sqliteDialect, COLUMNS, req({ anyColumn: one("name", { op: "contains", value: "x" }) }));
    expect(built.sql).toContain(`\nWHERE "name" LIKE ? ${LITE_ESC}\nLIMIT`);
  });

  it("keeps a trailing comment in raw SQL from swallowing the closing parenthesis", () => {
    const where = whereOf(sqliteDialect, one("id", { op: "rawSql", sql: "$$ > 5 -- five" })).where;
    expect(where).toBe(`(\n"id" > 5 -- five\n)`);
  });
});

describe("buildSelect: the statement", () => {
  it("lists every column, binds paging last and asks for the fetch limit it was given", () => {
    const built = buildSelect(postgresDialect, COLUMNS, req({ table: "users", schema: "auth", limit: 50, offset: 100, filters: one("id", { op: "eq", value: 7 }) }), 51);
    expect(built.sql).toBe([
      `SELECT "id", "name", "active", "created", "at"`,
      `FROM "auth"."users"`,
      `WHERE "id" = $1`,
      `LIMIT $2 OFFSET $3`,
    ].join("\n"));
    expect(built.params).toEqual([7, 51, 100]);
  });

  it("never writes a value into the statement text", () => {
    const hostile = `'; DROP TABLE t; --`;
    const built = buildSelect(sqliteDialect, COLUMNS, req({ filters: one("name", { op: "eq", value: hostile }) }));
    expect(built.sql).not.toContain("DROP");
    expect(built.params[0]).toBe(hostile);
  });

  it("renders the display form with literals and without paging", () => {
    const built = buildSelect(postgresDialect, COLUMNS, req({
      filters: one("name", { op: "contains", value: "it's" }),
      sort: [{ column: "id", dir: "DESC" }],
    }));
    expect(built.displaySql).toBe([
      `SELECT "id", "name", "active", "created", "at"`,
      `FROM "public"."t"`,
      `WHERE "name" ILIKE '%it''s%' ${PG_ESC}`,
      `ORDER BY "id" DESC`,
    ].join("\n"));
  });

  it("writes SQLite booleans as 1/0 in the display form", () => {
    const built = buildSelect(sqliteDialect, COLUMNS, req({ filters: one("active", { op: "eq", value: true }) }));
    expect(built.displaySql).toContain(`WHERE "active" = 1`);
    expect(built.params[0]).toBe(true);
  });

  it("sorts in the order given and drops a repeated column", () => {
    const sort: GridSort[] = [{ column: "name", dir: "DESC" }, { column: "id", dir: "ASC" }, { column: "name", dir: "ASC" }];
    expect(buildSelect(sqliteDialect, COLUMNS, req({ sort })).sql).toContain(`ORDER BY "name" DESC, "id" ASC`);
  });

  it("adds no ORDER BY of its own when nothing is sorted", () => {
    expect(buildSelect(sqliteDialect, COLUMNS, req()).sql).not.toContain("ORDER BY");
  });

  it("quotes names that are not plain identifiers", () => {
    const columns: DialectColumn[] = [{ name: `Tên "khách"`, type: "text", kind: "text" }, { name: "order-id", type: "INTEGER", kind: "number" }];
    const built = buildSelect(sqliteDialect, columns, req({ table: "đơn hàng", filters: one("order-id", { op: "eq", value: 1 }) }));
    expect(built.sql).toBe([`SELECT "Tên ""khách""", "order-id"`, `FROM "đơn hàng"`, `WHERE "order-id" = ?`, `LIMIT ? OFFSET ?`].join("\n"));
  });

  it("refuses a column the table does not have, in a filter or a sort", () => {
    expect(() => buildSelect(sqliteDialect, COLUMNS, req({ filters: one("nope", { op: "isNull" }) }))).toThrow(GridRequestError);
    expect(() => buildSelect(sqliteDialect, COLUMNS, req({ sort: [{ column: `id" DESC; --`, dir: "ASC" }] }))).toThrow(`Unknown column`);
  });

  it("refuses a table with no columns", () => {
    expect(() => buildSelect(sqliteDialect, [], req())).toThrow(GridRequestError);
  });
});

describe("buildCount", () => {
  it("counts under the same filters and ignores sort and paging", () => {
    const built = buildCount(postgresDialect, COLUMNS, req({
      filters: one("id", { op: "gt", value: 3 }),
      sort: [{ column: "id", dir: "DESC" }],
      offset: 500,
    }));
    expect(built).toEqual({ sql: `SELECT COUNT(*) AS count\nFROM "public"."t"\nWHERE "id" > $1`, params: [3] });
  });

  it("counts under the Multi column filter too", () => {
    const built = buildCount(sqliteDialect, COLUMNS, req({ anyColumn: [...one("id", { op: "eq", value: 5 }), ...one("name", { op: "eq", value: "5" })] }));
    expect(built).toEqual({ sql: `SELECT COUNT(*) AS count\nFROM "t"\nWHERE ("id" = ?\nOR "name" = ?)`, params: [5, "5"] });
  });
});

describe("buildDistinctValues", () => {
  const values = (over: Partial<ValidGridValuesRequest> = {}): ValidGridValuesRequest => ({
    table: "t", schema: null, filters: [], anyColumn: [], column: "name", search: "", ...over,
  });

  it("lists one column's distinct values in order, one past the limit asked for", () => {
    expect(buildDistinctValues(postgresDialect, COLUMNS, values(), 101)).toEqual({
      sql: `SELECT DISTINCT "name"\nFROM "public"."t"\nORDER BY "name"\nLIMIT $1 OFFSET $2`,
      params: [101, 0],
      displaySql: `SELECT DISTINCT "name"\nFROM "public"."t"\nORDER BY "name"`,
    });
  });

  it("applies the filters given, then a search on the column, binding paging last", () => {
    const built = buildDistinctValues(mysqlDialect, COLUMNS, values({
      filters: one("id", { op: "gt", value: 3 }),
      anyColumn: [...one("name", { op: "eq", value: "a" }), ...one("id", { op: "eq", value: 9 })],
      search: "50%",
    }), 101);
    expect(built.sql).toBe([
      "SELECT DISTINCT `name`",
      "FROM `t`",
      "WHERE `id` > ?\nAND `name` LIKE ? ESCAPE CHAR(92)\nAND (`name` = ?\nOR `id` = ?)",
      "ORDER BY `name`",
      "LIMIT ? OFFSET ?",
    ].join("\n"));
    expect(built.params).toEqual([3, "%50\\%%", "a", 9, 101, 0]);
    expect(built.displaySql).not.toContain("LIMIT");
  });

  it("refuses a column the table does not have", () => {
    expect(() => buildDistinctValues(sqliteDialect, COLUMNS, values({ column: "nope" }), 101)).toThrow(GridRequestError);
  });
});

describe("rawSqlConditions", () => {
  it("collects every SQL condition across columns and groups", () => {
    const filters: FilterGroup[] = [
      { column: "id", anyOf: [[{ op: "rawSql", sql: "$$ > 1" }], [{ op: "eq", value: 1 }]] },
      { column: "name", anyOf: [[{ op: "isNull" }, { op: "rawSql", sql: "$$ <> ''" }]] },
    ];
    expect(rawSqlConditions(filters)).toEqual(["$$ > 1", "$$ <> ''"]);
  });
});

describe("parseGridCountRequest", () => {
  it("reads `exact`, false unless it is true", () => {
    expect(parseGridCountRequest({ table: "t" }, null).exact).toBe(false);
    expect(parseGridCountRequest({ table: "t", exact: false }, null).exact).toBe(false);
    expect(parseGridCountRequest({ table: "t", exact: true }, null)).toMatchObject({ table: "t", exact: true, filters: [] });
  });

  it("refuses an `exact` that is not a boolean, and still checks the rest", () => {
    for (const exact of ["true", 1, null, {}]) expect(() => parseGridCountRequest({ table: "t", exact }, null)).toThrow("exact must be true or false");
    expect(() => parseGridCountRequest({ exact: true }, null)).toThrow(GridRequestError);
  });
});

describe("parseGridRequest", () => {
  it("fills in defaults", () => {
    expect(parseGridRequest({ table: "t" }, "public")).toEqual({ table: "t", schema: "public", filters: [], anyColumn: [], sort: [], offset: 0, limit: 100 });
    expect(parseGridRequest({ table: "t", schema: "auth" }, "public").schema).toBe("auth");
    expect(parseGridRequest({ table: "t" }, null).schema).toBeNull();
  });

  it("upper-cases the sort direction and defaults it to ASC", () => {
    expect(parseGridRequest({ table: "t", sort: [{ column: "a", dir: "desc" }, { column: "b" }] }, null).sort)
      .toEqual([{ column: "a", dir: "DESC" }, { column: "b", dir: "ASC" }]);
  });

  const bad: [string, unknown][] = [
    ["a body that is not an object", []],
    ["no table", {}],
    ["a schema that is not text", { table: "t", schema: 5 }],
    ["filters that are not a list", { table: "t", filters: {} }],
    ["a filter without a column", { table: "t", filters: [{ anyOf: [[{ op: "isNull" }]] }] }],
    ["a filter without conditions", { table: "t", filters: [{ column: "a", anyOf: [] }] }],
    ["an empty condition group", { table: "t", filters: [{ column: "a", anyOf: [[]] }] }],
    ["an unknown operator", { table: "t", filters: [{ column: "a", anyOf: [[{ op: "regex" }]] }] }],
    ["a comparison with no value", { table: "t", filters: [{ column: "a", anyOf: [[{ op: "gt" }]] }] }],
    ["a comparison with an object value", { table: "t", filters: [{ column: "a", anyOf: [[{ op: "eq", value: { x: 1 } }]] }] }],
    ["contains with no text", { table: "t", filters: [{ column: "a", anyOf: [[{ op: "contains", value: null }]] }] }],
    ["an empty in list", { table: "t", filters: [{ column: "a", anyOf: [[{ op: "in", values: [] }]] }] }],
    ["an in list that is too long", { table: "t", filters: [{ column: "a", anyOf: [[{ op: "in", values: Array.from({ length: 5001 }, (_, i) => i) }]] }] }],
    ["a date range with no bounds", { table: "t", filters: [{ column: "a", anyOf: [[{ op: "dateRange" }]] }] }],
    ["a date range bound that is not a date", { table: "t", filters: [{ column: "a", anyOf: [[{ op: "dateRange", from: "yesterday" }]] }] }],
    ["a date range offset that is not an offset", { table: "t", filters: [{ column: "a", anyOf: [[{ op: "dateRange", from: "2024-01-01", offset: "Asia/Saigon" }]] }] }],
    ["empty raw SQL", { table: "t", filters: [{ column: "a", anyOf: [[{ op: "rawSql", sql: "  " }]] }] }],
    ["raw SQL that starts a second statement", { table: "t", filters: [{ column: "a", anyOf: [[{ op: "rawSql", sql: "$$ = 1; DELETE FROM t" }]] }] }],
    ["raw SQL that is too long", { table: "t", filters: [{ column: "a", anyOf: [[{ op: "rawSql", sql: "x".repeat(4001) }]] }] }],
    ["a limit of zero", { table: "t", limit: 0 }],
    ["a limit past the cap", { table: "t", limit: 10_001 }],
    ["a fractional offset", { table: "t", offset: 1.5 }],
    ["a negative offset", { table: "t", offset: -1 }],
    ["a sort direction that is not ASC or DESC", { table: "t", sort: [{ column: "a", dir: "sideways" }] }],
  ];
  for (const [label, body] of bad) {
    it(`refuses ${label}`, () => {
      expect(() => parseGridRequest(body, null)).toThrow(GridRequestError);
    });
  }

  it("reads the Multi column filter like the column filters", () => {
    const anyColumn = [{ column: "a", anyOf: [[{ op: "contains", value: 5 }]] }];
    expect(parseGridRequest({ table: "t", anyColumn }, null).anyColumn).toEqual([{ column: "a", anyOf: [[{ op: "contains", value: "5" }]] }]);
    expect(() => parseGridRequest({ table: "t", anyColumn: {} }, null)).toThrow("anyColumn must be a list");
    expect(() => parseGridRequest({ table: "t", anyColumn: [{ column: "a", anyOf: [] }] }, null)).toThrow(GridRequestError);
  });

  it("refuses an SQL condition in the Multi column filter, where $$ names no one column", () => {
    const anyColumn = [{ column: "a", anyOf: [[{ op: "isNull" }], [{ op: "rawSql", sql: "$$ > 1" }]] }];
    expect(() => parseGridRequest({ table: "t", anyColumn }, null)).toThrow("An SQL condition only works in one column's own filter");
  });

  it("allows a semicolon inside a string literal in raw SQL", () => {
    const parsed = parseGridRequest({ table: "t", filters: [{ column: "a", anyOf: [[{ op: "rawSql", sql: "$$ = 'a;b'" }]] }] }, null);
    expect(parsed.filters[0]!.anyOf[0]![0]!.sql).toBe("$$ = 'a;b'");
  });

  it("turns a number typed into a text operator into text", () => {
    const parsed = parseGridRequest({ table: "t", filters: [{ column: "a", anyOf: [[{ op: "contains", value: 12 }]] }] }, null);
    expect(parsed.filters[0]!.anyOf[0]![0]!.value).toBe("12");
  });

  it("drops fields an operator does not use", () => {
    const parsed = parseGridRequest({ table: "t", filters: [{ column: "a", anyOf: [[{ op: "isNull", value: 1, sql: "x" }]] }] }, null);
    expect(parsed.filters[0]!.anyOf[0]![0]).toEqual({ op: "isNull" });
  });
});

describe("parseGridValuesRequest", () => {
  it("needs a column and fills in the rest", () => {
    expect(parseGridValuesRequest({ table: "t", column: "a" }, "public")).toEqual({
      table: "t", schema: "public", filters: [], anyColumn: [], column: "a", search: "",
    });
    expect(parseGridValuesRequest({ table: "t", column: "a", search: "x", filters: [{ column: "b", anyOf: [[{ op: "isNull" }]] }] }, null))
      .toEqual({ table: "t", schema: null, filters: [{ column: "b", anyOf: [[{ op: "isNull" }]] }], anyColumn: [], column: "a", search: "x" });
    expect(parseGridValuesRequest({ table: "t", column: "a", search: null }, null).search).toBe("");
  });

  const bad: [string, unknown, string][] = [
    ["no column", { table: "t" }, "column is required"],
    ["an empty column", { table: "t", column: "" }, "column is required"],
    ["a search that is not text", { table: "t", column: "a", search: 5 }, "search must be text"],
    ["a search past the cap", { table: "t", column: "a", search: "x".repeat(1001) }, "search may hold at most 1000 characters"],
    ["no table", { column: "a" }, "table is required"],
    ["filters that are not a list", { table: "t", column: "a", filters: {} }, "filters must be a list"],
  ];
  for (const [label, body, message] of bad) {
    it(`refuses ${label}`, () => {
      expect(() => parseGridValuesRequest(body, null)).toThrow(message);
    });
  }

  it("takes a search of exactly the cap", () => {
    expect(parseGridValuesRequest({ table: "t", column: "a", search: "x".repeat(1000) }, null).search).toHaveLength(1000);
  });
});
