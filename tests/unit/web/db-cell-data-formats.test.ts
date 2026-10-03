/**
 * DBGate's Cell data view without a browser: the formats and their order, Autodetect's pick, the
 * messages it shows instead of a format, and what each format makes of the selected cells.
 */
import { describe, expect, it } from "bun:test";
import { CompactSelection, type GridSelection } from "@glideapps/glide-data-grid";
import {
  CELL_DATA_FORMATS, CELL_DATA_MAX_CELLS, HTML_FRAME_POLICY, autodetectFormat, binaryHex, bytesRead, cellDataFields, cellDataFormat, cellDataMessage, cellText, cellsText,
  choiceTitle, collectCellData, formJsonValue, htmlDocument, imageType, pictureUrl, readJson, rowsJson, rowsOfCells,
  type CellDataCell, type CellDataSelection,
} from "../../../src/web/components/database/grid/cell-data-formats";
import type { DbBinaryValue } from "../../../src/shared/db-grid";

function selection(parts: { rects?: { x: number; y: number; width: number; height: number }[]; cols?: number[]; rows?: number[] }): GridSelection {
  const toList = (list: number[] = []) => list.reduce((s, i) => s.add(i), CompactSelection.empty());
  const [range, ...rangeStack] = parts.rects ?? [];
  return {
    columns: toList(parts.cols),
    rows: toList(parts.rows),
    ...(range ? { current: { cell: [range.x, range.y] as [number, number], range, rangeStack } } : {}),
  };
}

const bin = (bytes: number[], extra: Partial<DbBinaryValue> = {}): DbBinaryValue => ({
  $binary: btoa(String.fromCharCode(...bytes)), size: bytes.length, ...extra,
});
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];
const cell = (value: unknown, extra: Partial<CellDataCell> = {}): CellDataCell => ({ row: 0, column: "c", value, fullRow: false, ...extra });
const picked = (cells: CellDataCell[]): CellDataSelection => ({ cells, total: cells.length });

describe("the formats", () => {
  it("are DBGate's, in its order, and only Json, Json - expanded and Picture show a single cell", () => {
    expect(CELL_DATA_FORMATS.map((f) => f.title)).toEqual([
      "Text (wrap)", "Text (no wrap)", "Form", "Json", "Json - expanded", "Json - Row", "Picture", "HTML", "XML",
    ]);
    expect(CELL_DATA_FORMATS.filter((f) => f.single).map((f) => f.id)).toEqual(["json", "jsonExpanded", "picture"]);
  });

  it("names Autodetect after the format it picked", () => {
    expect(choiceTitle("autodetect", "json")).toBe("Autodetect - Json");
    expect(choiceTitle("autodetect", "textWrap")).toBe("Autodetect - Text (wrap)");
    expect(choiceTitle("xml", "json")).toBe("XML");
  });
});

describe("the selected cells", () => {
  const columns = ["id", "name", "prefs"];
  const valueAt = (row: number, column: string) => `${column}${row}`;

  it("are read row by row, left to right, whatever order the ranges were drawn in", () => {
    const sel = selection({ rects: [{ x: 1, y: 3, width: 2, height: 1 }, { x: 0, y: 1, width: 2, height: 2 }] });
    const got = collectCellData(sel, columns, 10, valueAt);
    expect(got.total).toBe(6);
    expect(got.cells.map((c) => `${c.column}${c.row}`)).toEqual(["id1", "name1", "id2", "name2", "name3", "prefs3"]);
    expect(got.cells.map((c) => c.value)).toEqual(["id1", "name1", "id2", "name2", "name3", "prefs3"]);
    expect(got.cells.every((c) => !c.fullRow)).toBe(true);
  });

  it("take every column of a row selected from its number, each marked as on a whole row", () => {
    const got = collectCellData(selection({ rows: [4] }), columns, 10, valueAt);
    expect(got.cells).toEqual([
      { row: 4, column: "id", value: "id4", fullRow: true },
      { row: 4, column: "name", value: "name4", fullRow: true },
      { row: 4, column: "prefs", value: "prefs4", fullRow: true },
    ]);
  });

  it("take every row of a column selected from its title, and count a cell two ranges share once", () => {
    expect(collectCellData(selection({ cols: [2] }), columns, 3, valueAt).cells.map((c) => c.value)).toEqual(["prefs0", "prefs1", "prefs2"]);
    const twice = selection({ rects: [{ x: 0, y: 0, width: 2, height: 1 }, { x: 1, y: 0, width: 1, height: 1 }] });
    expect(collectCellData(twice, columns, 3, valueAt).total).toBe(2);
  });

  it("are not read at all past the cap, which says how many there were", () => {
    let reads = 0;
    const got = collectCellData(selection({ cols: [0] }), columns, CELL_DATA_MAX_CELLS + 1, () => { reads++; return 1; });
    expect(got).toEqual({ cells: [], total: CELL_DATA_MAX_CELLS + 1 });
    expect(reads).toBe(0);
    expect(collectCellData(selection({ cols: [0] }), columns, CELL_DATA_MAX_CELLS, () => 1).cells).toHaveLength(CELL_DATA_MAX_CELLS);
  });

  it("lie on rows listed once each, in order", () => {
    const got = collectCellData(selection({ rects: [{ x: 0, y: 2, width: 3, height: 2 }] }), columns, 10, valueAt);
    expect(rowsOfCells(got.cells)).toEqual([2, 3]);
  });
});

describe("Autodetect", () => {
  it("picks Form when the first cell lies on a row selected whole", () => {
    expect(autodetectFormat([cell({ a: 1 }, { fullRow: true }), cell(1)])).toBe("form");
    expect(autodetectFormat([cell("x"), cell("y", { fullRow: true })])).toBe("textWrap");
  });

  it("picks Json for one object or list, and for text holding one", () => {
    expect(autodetectFormat([cell({ theme: "dark" })])).toBe("json");
    expect(autodetectFormat([cell([1, 2])])).toBe("json");
    expect(autodetectFormat([cell('{"theme":"dark"}')])).toBe("json");
    expect(autodetectFormat([cell("  [1, 2]\n")])).toBe("json");
    expect(autodetectFormat([cell("{not json")])).toBe("textWrap");
  });

  it("picks XML for text in angle brackets, untrimmed as DBGate reads it", () => {
    expect(autodetectFormat([cell("<a>b</a>")])).toBe("xml");
    expect(autodetectFormat([cell(" <a>b</a>")])).toBe("textWrap");
  });

  it("picks Picture for bytes that begin as an image, and text for other bytes", () => {
    expect(autodetectFormat([cell(bin(PNG))])).toBe("picture");
    expect(autodetectFormat([cell(bin([1, 2, 3, 4]))])).toBe("textWrap");
  });

  it("picks text for anything else, and for several cells whatever they hold", () => {
    expect(autodetectFormat([cell(42)])).toBe("textWrap");
    expect(autodetectFormat([cell(null)])).toBe("textWrap");
    expect(autodetectFormat([cell("plain")])).toBe("textWrap");
    expect(autodetectFormat([])).toBe("textWrap");
    expect(autodetectFormat([cell({ a: 1 }), cell({ b: 2 })])).toBe("textWrap");
  });
});

describe("the view's messages", () => {
  const json = cellDataFormat("json");
  const text = cellDataFormat("textWrap");

  it("asks for one cell for a single-cell format, before saying nothing is selected, as DBGate does", () => {
    expect(cellDataMessage(json, picked([cell(1), cell(2), cell(3)]))).toBe("Must be selected one cell");
    expect(cellDataMessage(json, picked([]))).toBe("Must be selected one cell");
    expect(cellDataMessage(json, picked([cell(1)]))).toBeNull();
  });

  it("says nothing is selected, and has nothing to say once something is", () => {
    expect(cellDataMessage(text, picked([]))).toBe("No data selected");
    expect(cellDataMessage(text, picked([cell(1), cell(2), cell(3)]))).toBeNull();
  });

  it("says when the selection is past what the view reads", () => {
    expect(cellDataMessage(text, { cells: [], total: CELL_DATA_MAX_CELLS + 1 })).toMatch(/^Too many cells selected \(100,001\)/);
  });
});

describe("the text formats", () => {
  it("show a value per line: NULL as nothing, an object as indented JSON", () => {
    expect(cellsText([cell("a"), cell(null), cell(undefined), cell(5), cell(true), cell({ a: 1 })])).toBe('a\n\n\n5\ntrue\n{\n  "a": 1\n}');
  });

  it("show bytes in hex, sixteen to a line", () => {
    const bytes = Array.from({ length: 20 }, (_, i) => i);
    expect(cellText(bin(bytes))).toBe("00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F\n10 11 12 13");
    expect(binaryHex(bin([]))).toBe("");
  });

  it("say when only the start of the bytes came with the row", () => {
    expect(binaryHex(bin([0xff, 0xd8], { size: 3 * 1024 * 1024, truncated: true })))
      .toBe("FF D8\n… 3.0 MB in all: only the first 2 bytes were read");
  });
});

describe("the Json formats", () => {
  it("take an object as it is and parse anything else as JSON text", () => {
    expect(readJson({ a: 1 })).toEqual({ ok: true, value: { a: 1 } });
    expect(readJson('{"a":[1,2]}')).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(readJson('"x"')).toEqual({ ok: true, value: "x" });
    expect(readJson(5)).toEqual({ ok: true, value: 5 });
    expect(readJson(null)).toEqual({ ok: true, value: null });
  });

  it("cannot read text that is not JSON, nothing, or bytes", () => {
    expect(readJson("hello")).toEqual({ ok: false });
    expect(readJson(undefined)).toEqual({ ok: false });
    expect(readJson(bin([1, 2]))).toEqual({ ok: false });
  });

  it("show one row as an object and several as a list", () => {
    expect(rowsJson([{ id: 1 }])).toEqual({ id: 1 });
    expect(rowsJson([{ id: 1 }, { id: 2 }])).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe("the Form format", () => {
  const columns = ["id", "created_at", "note", "meta"];

  it("has a field per column, with the rows' value where they agree and (Multiple values) where not", () => {
    const fields = cellDataFields(columns, [{ id: 1, created_at: "d", note: null, meta: { a: 1 } }, { id: 2, created_at: "d", note: undefined, meta: { a: 1 } }], "", false);
    expect(fields).toEqual([
      { column: "id", value: undefined, multiple: true },
      { column: "created_at", value: "d", multiple: false },
      // A new row's empty cell and NULL read alike, as DBGate compares them.
      { column: "note", value: null, multiple: false },
      { column: "meta", value: { a: 1 }, multiple: false },
    ]);
  });

  it("keeps the names Filter columns matches, by the capitals of their words too", () => {
    expect(cellDataFields(columns, [{}], "e", false).map((f) => f.column)).toEqual(["created_at", "note", "meta"]);
    expect(cellDataFields(columns, [{}], "CA", false).map((f) => f.column)).toEqual(["created_at"]);
  });

  it("drops the fields with nothing in them under Hide NULL values, but not those that differ", () => {
    const rows = [{ id: 1, created_at: null, note: "x", meta: null }, { id: 1, created_at: null, note: null, meta: undefined }];
    expect(cellDataFields(columns, rows, "", true).map((f) => f.column)).toEqual(["id", "note"]);
  });

  it("draws an object as a tree, and text only when it is long JSON", () => {
    expect(formJsonValue({ a: 1 })).toEqual({ a: 1 });
    expect(formJsonValue("[1,2]")).toBeNull();
    const long = JSON.stringify({ text: "x".repeat(120) });
    expect(formJsonValue(long)).toEqual({ text: "x".repeat(120) });
    expect(formJsonValue(`{${"x".repeat(120)}}`)).toBeNull();
    expect(formJsonValue(bin(PNG))).toBeNull();
    expect(formJsonValue(5)).toBeNull();
  });
});

describe("Picture", () => {
  it("knows an image by the bytes it begins with", () => {
    expect(imageType(bin(PNG))).toBe("image/png");
    expect(imageType(bin([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageType(bin([...Buffer.from("GIF89a")]))).toBe("image/gif");
    expect(imageType(bin([...Buffer.from("RIFF"), 1, 2, 3, 4, ...Buffer.from("WEBP")]))).toBe("image/webp");
    expect(imageType(bin([0x42, 0x4d, 1, 2]))).toBe("image/bmp");
    expect(imageType(bin([0, 0, 1, 0, 1, 0]))).toBe("image/x-icon");
    expect(imageType(bin([0, 0, 0, 0x1c, ...Buffer.from("ftypavif")]))).toBe("image/avif");
    expect(imageType(bin([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });

  it("is the bytes as a data URL — typed as PNG when nothing says otherwise — and nothing for a value that holds none", () => {
    const png = bin(PNG);
    expect(pictureUrl(png)).toBe(`data:image/png;base64,${png.$binary}`);
    const jpeg = bin([0xff, 0xd8, 0xff]);
    expect(pictureUrl(jpeg)).toBe(`data:image/jpeg;base64,${jpeg.$binary}`);
    const other = bin([9, 9, 9]);
    expect(pictureUrl(other)).toBe(`data:image/png;base64,${other.$binary}`);
    expect(pictureUrl(bin([]))).toBeNull();
    expect(pictureUrl("iVBORw0KGgo=")).toBeNull();
    expect(pictureUrl(null)).toBeNull();
  });
});

describe("bytes read", () => {
  it("counts the bytes the base64 holds, past its padding", () => {
    expect(bytesRead(bin([1]))).toBe(1);
    expect(bytesRead(bin([1, 2]))).toBe(2);
    expect(bytesRead(bin([1, 2, 3]))).toBe(3);
    expect(bytesRead(bin([1, 2, 3, 4]))).toBe(4);
    expect(bytesRead(bin([]))).toBe(0);
  });
});

describe("HTML", () => {
  const COLORS = { text: "rgb(1, 2, 3)", background: "rgb(4, 5, 6)" };
  const page = (html: string) => htmlDocument(html, COLORS);
  const head = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_FRAME_POLICY}">`
    + `<meta http-equiv="x-dns-prefetch-control" content="off">`
    + "<style>html{color:rgb(1, 2, 3);background:rgb(4, 5, 6);font:12.5px/1.5 system-ui,sans-serif}</style>";

  it("puts the value under a policy that loads nothing but what it holds, in the app's colours", () => {
    expect(HTML_FRAME_POLICY).toBe("default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'");
    expect(page("<p>hi <b>there</b></p>")).toBe(`${head}<p>hi <b>there</b></p>`);
  });

  it("takes out every meta and link, however a refresh is spelled or hidden", () => {
    expect(page('<META HTTP-EQUIV="Refresh" content="0;url=https://example.com">a')).toBe(`${head}a`);
    expect(page('<meta content="0;url=https://example.com" http-equiv=refresh>a')).toBe(`${head}a`);
    // `&#114;` is an r: the browser reads this one as a refresh too.
    expect(page('<meta http-equiv="&#114;efresh" content="0;url=https://example.com">a')).toBe(`${head}a`);
    expect(page("<me<meta>ta http-equiv=refresh content=0>a")).toBe(`${head}a`);
    expect(page('<meta/http-equiv=refresh/content=0>a<link rel="dns-prefetch" href="//example.com">b')).toBe(`${head}ab`);
    // A `>` in a quoted value ends the match early: what is left is text, not a tag.
    expect(page('<meta content="a>b" http-equiv=refresh>')).toBe(`${head}b" http-equiv=refresh>`);
    expect(page("<metadata>kept</metadata>")).toBe(`${head}<metadata>kept</metadata>`);
  });
});
