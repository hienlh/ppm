/**
 * DBGate's commands on the selection, as pure decisions: what Filter selected value writes in the
 * filter boxes, which columns Hide column hides, what Save cell to file saves, and how the JSON
 * documents read a row and put back what changed in it.
 */
import { describe, expect, it } from "bun:test";
import type { GridSelection } from "@glideapps/glide-data-grid";
import { CompactSelection } from "@glideapps/glide-data-grid";
import type { ColumnKind } from "../../../src/shared/db-column-kind.ts";
import {
  cellFile, cellFileBase, selectedColumnIndices, selectedValueFilters, type SelectedValue,
} from "../../../src/web/components/database/grid/selection-commands.ts";
import {
  documentChanges, newRowValues, readJsonDocuments, rowDocumentText, type DocumentColumn,
} from "../../../src/web/components/database/grid/json-document.ts";

/** The cells as the grid visits them, in order. */
const visiting = (cells: readonly SelectedValue[]) => (visit: (cell: SelectedValue) => void) => cells.forEach(visit);
const kinds = (map: Record<string, ColumnKind>) => (column: string) => map[column];
const filtersOf = (cells: readonly SelectedValue[], map: Record<string, ColumnKind>) => {
  const result = selectedValueFilters(visiting(cells), kinds(map));
  if (!result.ok) throw new Error(`refused on ${result.column}`);
  return Object.fromEntries(result.filters);
};

describe("Filter selected value", () => {
  it("writes each value once, in the order met, a column per filter", () => {
    expect(filtersOf([
      { column: "status", value: "paid" }, { column: "qty", value: 3 },
      { column: "status", value: "new" }, { column: "status", value: "paid" }, { column: "qty", value: 3 },
    ], { status: "text", qty: "number" })).toEqual({ status: '="paid",="new"', qty: '="3"' });
  });

  it("tells NULL from the text null, and writes a boolean as TRUE or FALSE", () => {
    expect(filtersOf([
      { column: "note", value: null }, { column: "note", value: "null" }, { column: "note", value: null },
      { column: "active", value: true }, { column: "active", value: 0 },
    ], { note: "text", active: "boolean" })).toEqual({ note: 'NULL,="null"', active: "TRUE,FALSE" });
  });

  it("passes over what no filter can spell: bytes, JSON, a new row's value nobody gave, a column it cannot read", () => {
    const bytes = { $binary: "AA==", size: 1 };
    expect(filtersOf([
      { column: "photo", value: bytes }, { column: "doc", value: { a: 1 } }, { column: "raw", value: "x" },
      { column: "name", value: undefined }, { column: "name", value: bytes }, { column: "ghost", value: "x" },
    ], { photo: "binary", doc: "json", raw: "binary", name: "text" })).toEqual({});
  });

  it("refuses a filter longer than the tab keeps, and takes one exactly as long", () => {
    // `="` + the value + `"`: three characters more than the value.
    const fits = "x".repeat(10_000 - 3);
    expect(filtersOf([{ column: "name", value: fits }], { name: "text" }).name).toHaveLength(10_000);
    const result = selectedValueFilters(visiting([
      { column: "qty", value: 1 }, { column: "name", value: `${fits}y` },
    ]), kinds({ qty: "number", name: "text" }));
    expect(result).toEqual({ ok: false, column: "name" });
  });
});

const selection = (current: { x: number; width: number }[] | null, columns: number[] = [], rows: number[] = []): GridSelection => ({
  columns: columns.reduce((s, c) => s.add(c), CompactSelection.empty()),
  rows: rows.reduce((s, r) => s.add(r), CompactSelection.empty()),
  current: current && {
    cell: [current[0]!.x, 0],
    range: { x: current[0]!.x, y: 0, width: current[0]!.width, height: 1 },
    rangeStack: current.slice(1).map((r) => ({ x: r.x, y: 2, width: r.width, height: 1 })),
  },
});

describe("Hide column's columns", () => {
  it("are every column a range lies in, each once, left to right, with the columns selected whole", () => {
    expect(selectedColumnIndices(selection([{ x: 3, width: 2 }, { x: 1, width: 3 }], [0, 4]), 6)).toEqual([0, 1, 2, 3, 4]);
  });

  it("are none for rows selected from their numbers, and none past the last column", () => {
    expect(selectedColumnIndices(selection(null, [], [0, 1]), 4)).toEqual([]);
    expect(selectedColumnIndices(selection([{ x: 2, width: 3 }], [7]), 3)).toEqual([2]);
    expect(selectedColumnIndices(selection([{ x: -1, width: 2 }]), 3)).toEqual([0]);
  });
});

describe("Save cell to file", () => {
  const bytes = (b64: string, more: { size?: number; truncated?: boolean } = {}) =>
    ({ $binary: b64, size: more.size ?? Math.floor((b64.replace(/=+$/, "").length * 3) / 4), ...more });
  const saved = (value: unknown, base = "t-c") => {
    const file = cellFile(value, base);
    if (!file.ok) throw new Error(file.reason);
    return { name: file.name, bytes: [...file.bytes] };
  };

  it("names the file for the table and column, in characters every system takes", () => {
    expect(cellFileBase("users", "avatar")).toBe("users-avatar");
    expect(cellFileBase(null, "avatar")).toBe("avatar");
    expect(cellFileBase("a/b\\c", 'd:e*?"<>|\u0001f')).toBe("a_b_c-d_e_f");
    expect(cellFileBase(null, " ..x.. ")).toBe("x");
    expect(cellFileBase("t", "c".repeat(200))).toHaveLength(120);
    expect(cellFileBase(null, "...")).toBe("cell");
    expect(cellFileBase(undefined, "")).toBe("cell");
  });

  it("saves text as UTF-8 in a .txt", () => {
    expect(saved("é!")).toEqual({ name: "t-c.txt", bytes: [0xc3, 0xa9, 0x21] });
  });

  it("saves bytes as they are, named for the picture they begin as, .bin otherwise", () => {
    const png = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1));
    expect(saved(bytes(png))).toEqual({ name: "t-c.png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1] });
    expect(saved(bytes(btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0)))).name).toBe("t-c.jpg");
    expect(saved(bytes(btoa(String.fromCharCode(0, 0, 1, 0, 9)))).name).toBe("t-c.ico");
    expect(saved(bytes("AAEC"))).toEqual({ name: "t-c.bin", bytes: [0, 1, 2] });
  });

  it("refuses bytes only partly read with the row, saying how much came", () => {
    expect(cellFile(bytes("AAEC", { size: 70_000, truncated: true }), "t-c"))
      .toEqual({ ok: false, reason: "Only the first 3 bytes of its 68.4 KB came with the row" });
  });

  it("refuses anything that is neither text nor bytes, and bytes that cannot be read", () => {
    for (const value of [5, true, null, { a: 1 }]) {
      expect(cellFile(value, "t-c")).toEqual({ ok: false, reason: "Only text and bytes can be saved to a file" });
    }
    expect(cellFile(bytes("@@@@", { size: 3 }), "t-c")).toEqual({ ok: false, reason: "Its bytes could not be read" });
  });
});

const COLUMNS: DocumentColumn[] = [
  { name: "id", kind: "number" }, { name: "name", kind: "text" }, { name: "active", kind: "boolean" },
  { name: "qty", kind: "number" }, { name: "meta", kind: "text" },
];

describe("reading a JSON document", () => {
  it("takes one object, or — adding rows — a list of them", () => {
    expect(readJsonDocuments('{"a":1}', false)).toEqual({ ok: true, documents: [{ a: 1 }] });
    expect(readJsonDocuments('{"a":1}', true)).toEqual({ ok: true, documents: [{ a: 1 }] });
    expect(readJsonDocuments('[{"a":1},{"b":2}]', true)).toEqual({ ok: true, documents: [{ a: 1 }, { b: 2 }] });
  });

  it("says what it cannot take", () => {
    const error = (text: string, many: boolean) => {
      const read = readJsonDocuments(text, many);
      return read.ok ? null : read.error;
    };
    expect(error("{a:1}", false)).toStartWith("Not valid JSON: ");
    expect(error("[{}]", false)).toBe("Write a JSON object");
    expect(error("null", false)).toBe("Write a JSON object");
    expect(error("5", true)).toBe("Write a JSON object, or a list of them");
    expect(error("[]", true)).toBe("The list is empty: there is no row to add");
    expect(error('[3, {}]', true)).toBe("Item 1 of the list is not an object");
    expect(error('[{}, 3]', true)).toBe("Item 2 of the list is not an object");
    expect(error('[{}, {}, [1]]', true)).toBe("Item 3 of the list is not an object");
  });
});

describe("Edit row as JSON document", () => {
  it("opens the row as the grid shows it, in column order, leaving out what a new row was not given", () => {
    expect(rowDocumentText({ qty: 2, name: null, active: undefined, id: 1, other: "x" }, COLUMNS))
      .toBe('{\n  "id": 1,\n  "name": null,\n  "qty": 2\n}');
  });

  const changes = (doc: Record<string, unknown>, now: Record<string, unknown>, canChange = (_: string) => true) => {
    const result = documentChanges(doc, now, COLUMNS, canChange);
    return result.ok ? result.changes : result.error;
  };
  const NOW = { id: 1, name: "Ann", active: 1, qty: 5, meta: { tags: ["a"] } };

  it("puts back only what changed, as the column takes it", () => {
    expect(changes({ ...NOW, name: "Bea", qty: "7", active: false }, NOW)).toEqual([
      { column: "name", value: "Bea" }, { column: "active", value: false }, { column: "qty", value: 7 },
    ]);
    expect(changes({ name: null, meta: { tags: [] } }, NOW)).toEqual([
      { column: "name", value: null }, { column: "meta", value: '{"tags":[]}' },
    ]);
    expect(changes({ name: 42 }, NOW)).toEqual([{ column: "name", value: "42" }]);
  });

  it("changes nothing for the same value written another way: SQLite's 1 for true, a number as text", () => {
    expect(changes({ ...NOW, active: true, qty: "5", meta: { tags: ["a"] } }, NOW)).toEqual([]);
    expect(changes({ meta: '{"tags":["a"]}' }, { ...NOW, meta: '{"tags":["a"]}' })).toEqual([]);
  });

  it("keeps a number too long for JavaScript as its digits", () => {
    expect(changes({ qty: "12345678901234567890" }, NOW)).toEqual([{ column: "qty", value: "12345678901234567890" }]);
  });

  it("lets a key it may not change stay as it is, and refuses to change it", () => {
    const keyLocked = (column: string) => column !== "id";
    expect(changes({ id: 1, name: "Bea" }, NOW, keyLocked)).toEqual([{ column: "name", value: "Bea" }]);
    expect(changes({ id: 2 }, NOW, keyLocked)).toBe("id cannot be changed here");
  });

  it("refuses a key that is no column, and a value the column cannot take", () => {
    expect(changes({ nope: 1 }, NOW)).toBe('"nope" is not a column of this table');
    expect(changes({ qty: "many" }, NOW)).toBe("qty: Not a number");
    expect(changes({ qty: true }, NOW)).toBe("qty: Not a number");
    expect(changes({ qty: [7] }, NOW)).toBe("qty: Not a number");
    expect(changes({ qty: "" }, NOW)).toBe("qty: Not a number");
    expect(changes({ active: "maybe" }, NOW)).toBe("active: Not true or false");
    expect(changes({ active: [] }, NOW)).toBe("active: Not true or false");
    expect(changes({ active: "" }, NOW)).toBe("active: Not true or false");
  });

  it("leaves bytes alone, and refuses to write new ones", () => {
    const photo = { $binary: "AAEC", size: 3 };
    const columns = [...COLUMNS, { name: "photo", kind: "text" as const }];
    expect(documentChanges({ photo }, { photo }, columns, () => true)).toEqual({ ok: true, changes: [] });
    expect(documentChanges({ photo: { $binary: "AA==", size: 1 } }, { photo }, columns, () => true))
      .toEqual({ ok: false, error: "photo holds bytes, which JSON cannot write" });
  });
});

describe("Add JSON document", () => {
  const rows = (docs: Record<string, unknown>[], filled = (column: string) => column === "id") => {
    const result = newRowValues(docs, COLUMNS, filled);
    return result.ok ? result.rows : result.error;
  };

  it("makes a row of each document, every value as its column takes it", () => {
    expect(rows([{ qty: "7", active: "t", meta: { a: 1 } }, {}])).toEqual([{ qty: 7, active: true, meta: '{"a":1}' }, {}]);
  });

  it("refuses a value for a key the database fills in", () => {
    expect(rows([{ id: 9, name: "x" }])).toBe("id is filled in by the database: leave it out");
    expect(rows([{ id: 9 }], () => false)).toEqual([{ id: 9 }]);
  });

  it("names the item it cannot take when there are several", () => {
    expect(rows([{ nope: 1 }])).toBe('"nope" is not a column of this table');
    expect(rows([{ name: "a" }, { nope: 1 }])).toBe('Item 2: "nope" is not a column of this table');
    expect(rows([{ qty: "x" }, { qty: "y" }])).toBe("Item 1: qty: Not a number");
    expect(rows([{ name: "a" }, { id: 1 }])).toBe("Item 2: id is filled in by the database: leave it out");
  });
});
