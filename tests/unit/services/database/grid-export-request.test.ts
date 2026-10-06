import { describe, expect, it } from "bun:test";
import type { DialectColumn } from "../../../../src/services/database/dialect.ts";
import { mysqlDialect } from "../../../../src/services/database/dialect-mysql.ts";
import { postgresDialect } from "../../../../src/services/database/dialect-postgres.ts";
import { GridRequestError, buildExportSelect, parseGridExportRequest } from "../../../../src/services/database/grid-query-builder.ts";
import { GRID_EXPORT_FORMATS, GRID_EXPORT_MAX_COLUMNS, gridExportFileName, isGridExportFormat } from "../../../../src/shared/db-grid-export.ts";

const COLUMNS: DialectColumn[] = [
  { name: "id", type: "integer", kind: "number" },
  { name: "name", type: "text", kind: "text" },
  { name: "doc", type: "jsonb", kind: "json" },
];

const parse = (body: Record<string, unknown>) => parseGridExportRequest({ table: "t", format: "csv", columns: ["id"], ...body }, "public");
const refusal = (body: Record<string, unknown>) => {
  try {
    parse(body);
  } catch (e) {
    expect(e).toBeInstanceOf(GridRequestError);
    return (e as Error).message;
  }
  throw new Error("accepted");
};

describe("parseGridExportRequest", () => {
  it("takes the grid's scope and sort, the columns in the order given, and the format", () => {
    const req = parse({
      columns: ["name", "id"], format: "xlsx", sort: [{ column: "id", dir: "DESC" }],
      filters: [{ column: "id", anyOf: [[{ op: "gt", value: 1 }]] }],
    });
    expect(req).toMatchObject({ table: "t", schema: "public", columns: ["name", "id"], format: "xlsx", sort: [{ column: "id", dir: "DESC" }] });
    expect(req.filters).toHaveLength(1);
  });

  it("refuses a format Export does not write, and names nothing it refuses for", () => {
    expect(refusal({ format: "pdf" })).toBe("format is not one Export writes");
    expect(refusal({ format: undefined })).toBe("format is not one Export writes");
    expect(refusal({ format: "toString" })).toBe("format is not one Export writes");
  });

  it("refuses columns that are missing, empty, not names, repeated or too many", () => {
    expect(refusal({ columns: undefined })).toBe("columns must list at least one column");
    expect(refusal({ columns: [] })).toBe("columns must list at least one column");
    expect(refusal({ columns: "id" })).toBe("columns must list at least one column");
    expect(refusal({ columns: ["id", ""] })).toBe("Every column must be a name");
    expect(refusal({ columns: ["id", 3] })).toBe("Every column must be a name");
    expect(refusal({ columns: ["id", "id"] })).toBe("A column is listed twice");
    const many = Array.from({ length: GRID_EXPORT_MAX_COLUMNS + 1 }, (_, i) => `c${i}`);
    expect(refusal({ columns: many })).toBe(`columns may list at most ${GRID_EXPORT_MAX_COLUMNS} columns`);
  });

  it("refuses a sort that is not a list", () => {
    expect(refusal({ sort: "id" })).toBe("sort must be a list");
  });
});

describe("buildExportSelect", () => {
  it("selects the columns in the order asked, filtered and sorted, with no paging", () => {
    const req = parse({
      columns: ["name", "id"], sort: [{ column: "id", dir: "DESC" }],
      filters: [{ column: "name", anyOf: [[{ op: "eq", value: "it's" }]] }],
    });
    const built = buildExportSelect(postgresDialect, COLUMNS, req);
    expect(built.sql).toBe(`SELECT "name", "id"\nFROM "public"."t"\nWHERE "name" = $1\nORDER BY "id" DESC`);
    expect(built.params).toEqual(["it's"]);
    expect(built.displaySql).toBe(`SELECT "name", "id"\nFROM "public"."t"\nWHERE "name" = 'it''s'\nORDER BY "id" DESC`);
    expect(built.columns.map((c) => [c.name, c.kind])).toEqual([["name", "text"], ["id", "number"]]);
  });

  it("quotes for the dialect", () => {
    const req = parseGridExportRequest({ table: "t", format: "csv", columns: ["id"] }, null);
    expect(buildExportSelect(mysqlDialect, COLUMNS, req).sql).toBe("SELECT `id`\nFROM `t`");
  });

  it("refuses a column the table does not have", () => {
    expect(() => buildExportSelect(postgresDialect, COLUMNS, parse({ columns: ["id", "nope"] }))).toThrow('Unknown column "nope"');
  });
});

describe("export formats and file names", () => {
  it("lists DBGate's quick exports in its order", () => {
    expect(GRID_EXPORT_FORMATS.map((f) => f.label)).toEqual([
      "JSON", "JSON lines/NDJSON", "SQL", "CSV file", "CSV file (semicolon separated)", "CSV file for MS Excel",
      "TSV file (tab separated)", "MS Excel", "XML file",
    ]);
    expect(isGridExportFormat("csvExcel")).toBe(true);
    expect(isGridExportFormat("constructor")).toBe(false);
  });

  it("names the file after the table, with what no file system takes replaced", () => {
    expect(gridExportFileName("users", "csvExcel")).toBe("users.csv");
    expect(gridExportFileName("a/b\\c:d*e?f\"g<h>i|j", "json")).toBe("a_b_c_d_e_f_g_h_i_j.json");
    expect(gridExportFileName("tab\tnew\nline", "tsv")).toBe("tab_new_line.tsv");
    expect(gridExportFileName("..hidden.", "xml")).toBe("hidden.xml");
    expect(gridExportFileName("  ", "xlsx")).toBe("export.xlsx");
    expect(gridExportFileName("đơn hàng", "jsonl")).toBe("đơn hàng.jsonl");
  });
});
