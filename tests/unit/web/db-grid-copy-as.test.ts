import { afterEach, describe, expect, it } from "bun:test";
import { CompactSelection, type GridSelection } from "@glideapps/glide-data-grid";
import {
  COPY_FORMATS, DEFAULT_COPY_FORMAT, copyFormatLabel, formatCopy, keepCopyFormat, readCopyFormat, sqlKeyCondition, sqlTableName,
  type CopyData, type CopySqlTarget,
} from "../../../src/web/components/database/grid/copy-as.ts";
import { selectedBlock } from "../../../src/web/components/database/grid/selection-stats.ts";

/**
 * DBGate's Copy / Copy advanced: what each of the nine formats writes for the rows and columns a
 * selection covers, NULL and a new row's empty cells included.
 */

const pg: CopySqlTarget = { table: "users", schema: "public", dialect: "postgres", keyColumns: ["id"] };

function data(columns: string[], ...rows: Record<string, unknown>[]): CopyData {
  return { columns, rows };
}

describe("the nine formats DBGate offers", () => {
  it("are listed in DBGate's order, with its labels and Set format names", () => {
    expect(COPY_FORMATS.map((f) => [f.id, f.label, f.name])).toEqual([
      ["textWithHeaders", "Copy with headers", "With headers"],
      ["textWithoutHeaders", "Copy without headers", "Without headers"],
      ["headers", "Copy only headers", "Only Headers"],
      ["csv", "Copy as CSV", "CSV"],
      ["json", "Copy as JSON", "JSON"],
      ["jsonLines", "Copy as JSON lines/NDJSON", "JSON lines/NDJSON"],
      ["yaml", "Copy as YAML", "YAML"],
      ["inserts", "Copy as SQL INSERTs", "SQL INSERTs"],
      ["updates", "Copy as SQL UPDATEs", "SQL UPDATEs"],
    ]);
    expect(DEFAULT_COPY_FORMAT).toBe("textWithoutHeaders");
    expect(copyFormatLabel("csv")).toBe("Copy as CSV");
  });
});

describe("text", () => {
  const two = data(["id", "name"], { id: 1, name: "Ann" }, { id: 2, name: null });

  it("writes values tab-separated, a line per row, with Windows line ends", () => {
    expect(formatCopy("textWithoutHeaders", two, pg)).toBe("1\tAnn\r\n2\t");
    expect(formatCopy("textWithHeaders", two, pg)).toBe("id\tname\r\n1\tAnn\r\n2\t");
    expect(formatCopy("headers", two, pg)).toBe("id\tname");
  });

  it("copies a single value exactly as it is, whatever it holds", () => {
    for (const v of ['say "hi"', "a\tb", "two\nlines", "cr\rhere"]) {
      expect(formatCopy("textWithoutHeaders", data(["v"], { v }), pg)).toBe(v);
    }
    expect(formatCopy("textWithoutHeaders", data(["v"], { v: null }), pg)).toBe("");
    // With its header it is a table of one, quoted like any other.
    expect(formatCopy("textWithHeaders", data(["v"], { v: "a\tb" }), pg)).toBe('v\r\n"a\tb"');
  });

  it("quotes a value holding a tab, a line break or a quote, the way a spreadsheet does", () => {
    const rows = data(["a", "b"], { a: "x\ty", b: 'say "hi"' }, { a: "one\ntwo", b: "cr\rhere" }, { a: "a,b", b: "plain" });
    expect(formatCopy("textWithoutHeaders", rows, pg)).toBe('"x\ty"\t"say ""hi"""\r\n"one\ntwo"\t"cr\rhere"\r\na,b\tplain');
    expect(formatCopy("headers", data(['say "x"', "tab\there"]), pg)).toBe('"say ""x"""\t"tab\there"');
  });

  it("leaves a cell a new row was given nothing in empty, as NULL is", () => {
    expect(formatCopy("textWithoutHeaders", data(["a", "b"], { a: 1 }, { b: 2 }), pg)).toBe("1\t\r\n\t2");
  });

  it("writes JSON as JSON, bytes as the cell shows them and booleans as words", () => {
    const rows = data(["j", "b", "t"], { j: { k: [1] }, b: { $binary: "AAH/", size: 3 }, t: true }, { j: [1, 2], b: null, t: false });
    expect(formatCopy("textWithoutHeaders", rows, pg)).toBe('"{""k"":[1]}"\t3 bytes · 00 01 FF\ttrue\r\n[1,2]\t\tfalse');
  });
});

describe("CSV", () => {
  it("writes a header row and comma-separated values, quoted as RFC 4180 has it", () => {
    const rows = data(["id", "note"], { id: 1, note: "a,b" }, { id: 2, note: 'say "hi"' }, { id: 3, note: "x\ny" }, { id: 4, note: "cr\r" }, { id: 5, note: "tab\tok" });
    expect(formatCopy("csv", rows, pg)).toBe('id,note\r\n1,"a,b"\r\n2,"say ""hi"""\r\n3,"x\ny"\r\n4,"cr\r"\r\n5,tab\tok');
  });

  it("writes NULL and an empty cell as nothing, and quotes a header that needs it", () => {
    expect(formatCopy("csv", data(["a,b", "c"], { "a,b": null }), pg)).toBe('"a,b",c\r\n,');
  });

  it("keeps its header even for a single value", () => {
    expect(formatCopy("csv", data(["v"], { v: 7 }), pg)).toBe("v\r\n7");
  });
});

describe("JSON, JSON lines and YAML", () => {
  const rows = data(["id", "name", "meta"], { id: 1, name: null, meta: { tags: ["a"] } }, { id: 2, name: "Bo" });

  it("write one object per row in column order: NULL as null, a cell given nothing left out", () => {
    expect(formatCopy("json", rows, pg)).toBe(JSON.stringify([{ id: 1, name: null, meta: { tags: ["a"] } }, { id: 2, name: "Bo" }], null, 2));
    expect(formatCopy("jsonLines", rows, pg)).toBe('{"id":1,"name":null,"meta":{"tags":["a"]}}\r\n{"id":2,"name":"Bo"}');
    expect(formatCopy("yaml", rows, pg)).toBe("- id: 1\n  name: null\n  meta:\n    tags:\n      - a\n- id: 2\n  name: Bo\n");
  });

  it("take only the columns asked for, in the order given", () => {
    const row = { id: 1, secret: "x", name: "Ann" };
    expect(formatCopy("jsonLines", data(["name", "id"], row), pg)).toBe('{"name":"Ann","id":1}');
    expect(formatCopy("json", data(["name", "id"], row), pg)).toBe('[\n  {\n    "name": "Ann",\n    "id": 1\n  }\n]');
    expect(formatCopy("yaml", data(["name", "id"], row), pg)).toBe("- name: Ann\n  id: 1\n");
  });
});

describe("SQL INSERTs", () => {
  it("writes one statement per row, a cell given nothing left out of it", () => {
    const rows = data(["id", "name", "note"], { id: 1, name: "it's", note: null }, { id: 2, name: "Bo" }, {});
    expect(formatCopy("inserts", rows, pg)).toBe([
      `INSERT INTO "public"."users" ("id", "name", "note") VALUES (1, 'it''s', NULL);`,
      `INSERT INTO "public"."users" ("id", "name") VALUES (2, 'Bo');`,
    ].join("\n"));
  });

  it("spells names and values for the connection's engine", () => {
    const row = { "o`k": "C:\\t", flag: true, n: "9007199254740993" };
    const kinds = new Map([["n", "number" as const]]);
    expect(formatCopy("inserts", data(["o`k", "flag", "n"], row), { table: "t", schema: "shop", dialect: "mysql", keyColumns: [], kinds }))
      .toBe("INSERT INTO `t` (`o``k`, `flag`, `n`) VALUES ('C:\\\\t', TRUE, 9007199254740993);");
    expect(formatCopy("inserts", data(["flag"], { flag: false }), { table: "t", dialect: "sqlite", keyColumns: [] }))
      .toBe(`INSERT INTO "t" ("flag") VALUES (0);`);
  });

  it("writes bytes in full, and refuses to write the start of bytes it does not have", () => {
    const whole = { $binary: "AAH/", size: 3 };
    const head = { $binary: "AAH/", size: 90_000, truncated: true };
    expect(formatCopy("inserts", data(["b"], { b: whole }, { b: head }), pg)).toBe([
      `INSERT INTO "public"."users" ("b") VALUES ('\\x0001ff');`,
      `INSERT INTO "public"."users" ("b") VALUES (/* 90000 bytes, not loaded */);`,
    ].join("\n"));
  });
});

describe("SQL UPDATEs", () => {
  it("sets every copied column and finds the row by its key", () => {
    const rows = data(["id", "name"], { id: 1, name: "Ann" }, { id: 2, name: null });
    expect(formatCopy("updates", rows, pg)).toBe([
      `UPDATE "public"."users" SET "id"=1, "name"='Ann' WHERE "id"=1;`,
      `UPDATE "public"."users" SET "id"=2, "name"=NULL WHERE "id"=2;`,
    ].join("\n"));
  });

  it("finds a row whose key was edited and not saved by the key the database still holds", () => {
    const now = { id: 9, name: "Ann" };
    expect(formatCopy("updates", { columns: ["id", "name"], rows: [now], stored: [{ id: 1, name: "Anne" }] }, pg))
      .toBe(`UPDATE "public"."users" SET "id"=9, "name"='Ann' WHERE "id"=1;`);
  });

  it("finds a row by every key column, a NULL one by IS NULL", () => {
    const target: CopySqlTarget = { table: "stock", dialect: "sqlite", keyColumns: ["shop", "sku"] };
    expect(formatCopy("updates", data(["qty"], { shop: null, sku: "a'1", qty: 3 }), target))
      .toBe(`UPDATE "stock" SET "qty"=3 WHERE "shop" IS NULL AND "sku"='a''1';`);
  });

  it("sets a number column's long digits bare, as it finds the row by them", () => {
    const kinds = new Map([["id", "number" as const], ["n", "number" as const]]);
    expect(formatCopy("updates", data(["n"], { id: "9007199254740993", n: "12345678901234567890" }), { ...pg, kinds }))
      .toBe(`UPDATE "public"."users" SET "n"=12345678901234567890 WHERE "id"=9007199254740993;`);
  });

  it("writes nothing for a row with nothing to set, or a table with no key to find it by", () => {
    expect(formatCopy("updates", data(["name"], { id: 1 }), pg)).toBe("");
    expect(formatCopy("updates", data(["name"], { name: "x" }), { ...pg, keyColumns: [] })).toBe("");
  });
});

describe("where the statements write to", () => {
  it("names a Postgres table with its schema, and a MySQL or SQLite one alone", () => {
    expect(sqlTableName({ table: 'a"b', schema: "s p", dialect: "postgres" })).toBe('"s p"."a""b"');
    expect(sqlTableName({ table: "t", schema: null, dialect: "postgres" })).toBe('"t"');
    expect(sqlTableName({ table: "t", schema: "shop", dialect: "mysql" })).toBe("`t`");
    expect(sqlTableName({ table: "t", schema: "main", dialect: "sqlite" })).toBe('"t"');
  });

  it("matches a key by value, with a number column's long digits bare", () => {
    const kinds = new Map([["id", "number" as const]]);
    expect(sqlKeyCondition({ id: "9007199254740993", region: undefined }, ["id", "region"], { dialect: "postgres", kinds }))
      .toBe(`"id"=9007199254740993 AND "region" IS NULL`);
  });
});

describe("the format Ctrl+C copies in", () => {
  afterEach(() => localStorage.removeItem("ppm-db-copy-format"));

  it("is DBGate's default until one is set, then the one set", () => {
    expect(readCopyFormat()).toBe("textWithoutHeaders");
    keepCopyFormat("csv");
    expect(readCopyFormat()).toBe("csv");
    expect(localStorage.getItem("ppm-db-copy-format")).toBe("csv");
  });

  it("falls back to the default for anything it does not know", () => {
    localStorage.setItem("ppm-db-copy-format", "mongoInsert");
    expect(readCopyFormat()).toBe("textWithoutHeaders");
  });

  it("still copies when the browser refuses storage", () => {
    const real = globalThis.localStorage;
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    Object.defineProperty(globalThis, "localStorage", { value: refusing, configurable: true });
    try {
      expect(readCopyFormat()).toBe("textWithoutHeaders");
      expect(() => keepCopyFormat("json")).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "localStorage", { value: real, configurable: true });
    }
  });
});

function selection(parts: { rects?: { x: number; y: number; width: number; height: number }[]; cols?: number[]; rows?: number[] }): GridSelection {
  const toList = (list: number[] = []) => list.reduce((s, i) => s.add(i), CompactSelection.empty());
  const [range, ...rangeStack] = parts.rects ?? [];
  return {
    columns: toList(parts.cols),
    rows: toList(parts.rows),
    ...(range ? { current: { cell: [range.x, range.y] as [number, number], range, rangeStack } } : {}),
  };
}

describe("the block a selection copies", () => {
  it("is the rows by the columns of a range", () => {
    expect(selectedBlock(selection({ rects: [{ x: 1, y: 2, width: 2, height: 3 }] }), 5, 10)).toEqual({ rows: [2, 3, 4], columns: [1, 2] });
  });

  it("joins ranges into one block, in order, each index once", () => {
    const sel = selection({ rects: [{ x: 3, y: 5, width: 1, height: 1 }, { x: 0, y: 1, width: 2, height: 1 }, { x: 1, y: 1, width: 1, height: 1 }] });
    expect(selectedBlock(sel, 5, 10)).toEqual({ rows: [1, 5], columns: [0, 1, 3] });
  });

  it("takes every row of a whole column and every column of a whole row", () => {
    expect(selectedBlock(selection({ cols: [2] }), 4, 3)).toEqual({ rows: [0, 1, 2], columns: [2] });
    expect(selectedBlock(selection({ rows: [1] }), 3, 4)).toEqual({ rows: [1], columns: [0, 1, 2] });
  });

  it("stays inside the grid, and is empty for nothing selected", () => {
    expect(selectedBlock(selection({ rects: [{ x: 2, y: 3, width: 4, height: 4 }] }), 3, 5)).toEqual({ rows: [3, 4], columns: [2] });
    expect(selectedBlock(selection({ cols: [7], rows: [9] }), 3, 5)).toEqual({ rows: [], columns: [] });
    expect(selectedBlock(selection({ cols: [0] }), 3, 0)).toEqual({ rows: [], columns: [] });
    expect(selectedBlock(selection({}), 3, 5)).toEqual({ rows: [], columns: [] });
  });
});
