/**
 * The data grid's rules that need no browser: DBGate's column menu, when the next 100 rows are
 * read, what a selection covers (Rows / Count / Sum and the rows Delete row(s) takes), how a NULL
 * and bytes show in a cell, and how a column title gives way as the column narrows.
 */
import { describe, expect, it } from "bun:test";
import { CompactSelection, type GridSelection } from "@glideapps/glide-data-grid";
import { addToSort, columnMenuItems, sortBy, sortPosition } from "../../../src/web/components/database/grid/column-menu";
import { loadMoreDecision } from "../../../src/web/components/database/grid/load-more";
import {
  forEachSelectedCell, numericValue, selectedRowIndices, selectionStats,
} from "../../../src/web/components/database/grid/selection-stats";
import { NULL_TEXT, formatBinary, formatByteSize, isBinaryValue } from "../../../src/web/components/database/grid/cell-display";
import {
  MENU_BUTTON_ROOM, columnTitleDrawer, fitText, layoutTitle, rowMarkerWidth, titleFonts, titleIcon,
  type TitleColumn,
} from "../../../src/web/components/database/grid/header-bands";

const labels = (items: ReturnType<typeof columnMenuItems>) =>
  items.map((i) => (i.kind === "separator" ? "—" : i.label));

describe("the column menu", () => {
  it("offers only the two sorts and Copy while nothing is sorted", () => {
    expect(labels(columnMenuItems("qty", []))).toEqual(["Sort ascending", "Sort descending", "Copy column name"]);
  });

  it("offers Add to sort on a column the sort does not have yet", () => {
    const sort = [{ column: "id", dir: "ASC" as const }];
    expect(labels(columnMenuItems("qty", sort))).toEqual([
      "Sort ascending", "Sort descending", "Add to sort - ascending", "Add to sort - descending", "Copy column name",
    ]);
  });

  it("offers Clear sort criteria, and no Add to sort, on a column already sorted by", () => {
    const sort = [{ column: "id", dir: "ASC" as const }, { column: "qty", dir: "DESC" as const }];
    expect(labels(columnMenuItems("qty", sort))).toEqual(["Sort ascending", "Sort descending", "Clear sort criteria", "Copy column name"]);
  });

  it("ends with the table a foreign key refers to, after a separator", () => {
    expect(labels(columnMenuItems("customer_id", [], "customers"))).toEqual([
      "Sort ascending", "Sort descending", "Copy column name", "—", "customers",
    ]);
    const last = columnMenuItems("customer_id", [], "customers").at(-1)!;
    expect(last).toEqual({ kind: "open-table", label: "customers", table: "customers" });
  });

  it("replaces the whole sort with Sort ascending, appends with Add to sort, empties with Clear", () => {
    const sort = [{ column: "id", dir: "ASC" as const }];
    const items = columnMenuItems("qty", sort);
    const byLabel = (label: string) => items.find((i) => i.kind === "sort" && i.label === label) as { sort: unknown };
    expect(byLabel("Sort ascending").sort).toEqual([{ column: "qty", dir: "ASC" }]);
    expect(byLabel("Sort descending").sort).toEqual([{ column: "qty", dir: "DESC" }]);
    expect(byLabel("Add to sort - descending").sort).toEqual([{ column: "id", dir: "ASC" }, { column: "qty", dir: "DESC" }]);
    const sorted = columnMenuItems("id", sort).find((i) => i.kind === "sort" && i.label === "Clear sort criteria") as { sort: unknown };
    // Every column's sort, not only this one's.
    expect(sorted.sort).toEqual([]);
  });

  it("ticks a sort item only while that column alone is sorted that way", () => {
    const ticked = (column: string, sort: Parameters<typeof columnMenuItems>[1]) =>
      columnMenuItems(column, sort).filter((i) => i.kind === "sort" && i.checked).map((i) => (i as { label: string }).label);
    expect(ticked("qty", [{ column: "qty", dir: "DESC" }])).toEqual(["Sort descending"]);
    expect(ticked("qty", [{ column: "qty", dir: "ASC" }])).toEqual(["Sort ascending"]);
    expect(ticked("qty", [{ column: "id", dir: "ASC" }, { column: "qty", dir: "ASC" }])).toEqual([]);
    expect(ticked("qty", [])).toEqual([]);
  });

  it("knows where a column stands in the sort", () => {
    const sort = [{ column: "a", dir: "ASC" as const }, { column: "b", dir: "DESC" as const }];
    expect(sortPosition(sort, "a")).toEqual({ dir: "ASC", index: 1 });
    expect(sortPosition(sort, "b")).toEqual({ dir: "DESC", index: 2 });
    expect(sortPosition(sort, "c")).toBeNull();
    expect(sortBy("x", "DESC")).toEqual([{ column: "x", dir: "DESC" }]);
    // A column added again moves to the end, with its new direction.
    expect(addToSort(sort, "a", "DESC")).toEqual([{ column: "b", dir: "DESC" }, { column: "a", dir: "DESC" }]);
  });
});

describe("reading the next rows", () => {
  const base = { lastVisibleRow: 99, loadedRows: 100, hasMore: true, busy: false, newRows: 0 };

  it("asks once the last row read is in view", () => {
    expect(loadMoreDecision(base)).toBe("load");
    expect(loadMoreDecision({ ...base, lastVisibleRow: 120 })).toBe("load");
    expect(loadMoreDecision({ ...base, lastVisibleRow: 98 })).toBe("idle");
  });

  it("does not ask when there is nothing more, or while rows are being read", () => {
    expect(loadMoreDecision({ ...base, hasMore: false })).toBe("idle");
    expect(loadMoreDecision({ ...base, busy: true })).toBe("idle");
  });

  it("waits for new rows to be saved or reverted, since they sit under the rows read", () => {
    expect(loadMoreDecision({ ...base, newRows: 1, lastVisibleRow: 100 })).toBe("blocked-by-new-rows");
    // Not in view yet: nothing to say.
    expect(loadMoreDecision({ ...base, newRows: 1, lastVisibleRow: 50 })).toBe("idle");
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

describe("what a selection covers", () => {
  it("visits each cell once, however the parts overlap", () => {
    const seen: string[] = [];
    forEachSelectedCell(
      selection({ rects: [{ x: 0, y: 0, width: 2, height: 2 }, { x: 1, y: 1, width: 2, height: 1 }], cols: [1], rows: [0] }),
      3, 3, (c, r) => seen.push(`${c}:${r}`),
    );
    expect(seen.length).toBe(new Set(seen).size);
    expect(new Set(seen)).toEqual(new Set(["0:0", "1:0", "0:1", "1:1", "2:1", "1:2", "2:0"]));
  });

  it("keeps to the grid's own size", () => {
    const seen: string[] = [];
    forEachSelectedCell(selection({ rects: [{ x: 1, y: 1, width: 5, height: 5 }] }), 2, 2, (c, r) => seen.push(`${c}:${r}`));
    expect(seen).toEqual(["1:1"]);
  });

  it("counts the rows, the cells and the numbers' sum of two cells or more", () => {
    const values: Record<string, unknown> = { "0:0": 2, "0:1": "3.5", "0:2": "abc", "1:0": null, "1:1": 4 };
    const stats = selectionStats(selection({ rects: [{ x: 0, y: 0, width: 2, height: 3 }] }), 2, 3, (c, r) => values[`${c}:${r}`]);
    expect(stats).toEqual({ rows: 3, count: 6, sum: 9.5 });
  });

  it("says nothing below two cells, and no sum without a number", () => {
    expect(selectionStats(selection({ rects: [{ x: 0, y: 0, width: 1, height: 1 }] }), 2, 2, () => 5)).toBeNull();
    expect(selectionStats(selection({}), 2, 2, () => 5)).toBeNull();
    expect(selectionStats(selection({ rows: [0] }), 2, 2, () => "x")).toEqual({ rows: 1, count: 2, sum: null });
  });

  it("drops floating point noise from the sum", () => {
    const stats = selectionStats(selection({ rects: [{ x: 0, y: 0, width: 1, height: 2 }] }), 1, 2, (_c, r) => (r === 0 ? 0.1 : 0.2));
    expect(stats?.sum).toBe(0.3);
  });

  it("reads numbers the way a cell holds them", () => {
    expect(numericValue(7)).toBe(7);
    expect(numericValue(" -1.5e3 ")).toBe(-1500);
    expect(numericValue(".5")).toBe(0.5);
    expect(numericValue("")).toBeNull();
    expect(numericValue("12abc")).toBeNull();
    expect(numericValue(Number.NaN)).toBeNull();
    expect(numericValue(Infinity)).toBeNull();
    expect(numericValue(true)).toBeNull();
  });

  it("deletes the rows a range or a row covers, never a whole column's", () => {
    expect(selectedRowIndices(selection({ rects: [{ x: 0, y: 2, width: 3, height: 2 }], rows: [0, 3] }), 10)).toEqual([0, 2, 3]);
    expect(selectedRowIndices(selection({ cols: [1] }), 10)).toEqual([]);
    expect(selectedRowIndices(selection({ rows: [9, 12] }), 10)).toEqual([9]);
  });
});

describe("how a cell shows what the canvas cannot draw", () => {
  it("spells NULL as DBGate does", () => {
    expect(NULL_TEXT).toBe("(NULL)");
  });

  it("knows bytes when it sees them", () => {
    expect(isBinaryValue({ $binary: "AAE=", size: 2 })).toBe(true);
    expect(isBinaryValue({ $binary: "AAE=" })).toBe(false);
    expect(isBinaryValue({ size: 2 })).toBe(false);
    expect(isBinaryValue(null)).toBe(false);
    expect(isBinaryValue("AAE=")).toBe(false);
  });

  it("gives bytes their size and the first eight in hex", () => {
    // A PNG's signature.
    expect(formatBinary({ $binary: btoa("\x89PNG\r\n\x1a\n\x00\x00"), size: 12_390 })).toBe("12.1 KB · 89 50 4E 47 0D 0A 1A 0A…");
    expect(formatBinary({ $binary: btoa("\x01\x02"), size: 2 })).toBe("2 bytes · 01 02");
    expect(formatBinary({ $binary: btoa("\x01\x02\x03\x04\x05\x06\x07\x08"), size: 8 })).toBe("8 bytes · 01 02 03 04 05 06 07 08");
    expect(formatBinary({ $binary: "", size: 0 })).toBe("0 bytes");
    // A preview that does not decode still says the size.
    expect(formatBinary({ $binary: "%%%", size: 5 })).toBe("5 bytes");
  });

  it("says sizes in the unit that reads", () => {
    expect(formatByteSize(1)).toBe("1 byte");
    expect(formatByteSize(1023)).toBe("1023 bytes");
    expect(formatByteSize(1024)).toBe("1.0 KB");
    expect(formatByteSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatByteSize(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});

/** Every character is 6px wide; the font is ignored. */
const measure = (text: string) => text.length * 6;
const FONTS = titleFonts("Geist", "mono");
const COL: TitleColumn = { name: "customer_id", type: "integer", notNull: false, icon: "headerFk" };

describe("a column's title", () => {
  it("keeps the whole name and type in a wide column", () => {
    const l = layoutTitle(COL, null, 300, FONTS, measure);
    expect(l).toMatchObject({ iconX: 8, nameX: 27, name: "customer_id", type: "integer", arrowX: null, indexX: null });
    expect(l.typeX).toBe(27 + 66 + 5);
  });

  it("gives up the type first, then the name, and never the menu button's room", () => {
    // Room for the name and part of the type.
    expect(layoutTitle(COL, null, 27 + 66 + 5 + 30 + MENU_BUTTON_ROOM, FONTS, measure)).toMatchObject({ name: "customer_id", type: "inte…" });
    // Less than a useful piece of the type: none of it.
    expect(layoutTitle(COL, null, 27 + 66 + 5 + 12 + MENU_BUTTON_ROOM, FONTS, measure).type).toBe("");
    // The name cut to the longest start that fits with its ellipsis, the type gone.
    const narrow = layoutTitle(COL, null, 27 + 36 + MENU_BUTTON_ROOM, FONTS, measure);
    expect(narrow).toMatchObject({ name: "custo…", type: "" });
  });

  it("shows the sort's arrow in place of the type, and its place only when several columns are sorted", () => {
    const alone = layoutTitle(COL, { dir: "ASC", index: null }, 300, FONTS, measure);
    expect(alone).toMatchObject({ type: "", index: "", indexX: null });
    expect(alone.arrowX).toBe(27 + 66 + 5);
    const second = layoutTitle(COL, { dir: "DESC", index: 2 }, 300, FONTS, measure);
    expect(second).toMatchObject({ index: "2" });
    expect(second.indexX).toBe(second.arrowX! + 10 + 1);
  });

  it("keeps the sort mark whole and cuts the name for it", () => {
    const l = layoutTitle(COL, { dir: "ASC", index: 3 }, 27 + 30 + 5 + 10 + 1 + 6 + MENU_BUTTON_ROOM, FONTS, measure);
    expect(l).toMatchObject({ name: "cust…", index: "3", arrowX: 27 + 30 + 5, indexX: 27 + 30 + 5 + 10 + 1 });
  });

  it("starts at the padding when there is no icon", () => {
    expect(layoutTitle({ ...COL, icon: null }, null, 300, FONTS, measure)).toMatchObject({ iconX: null, nameX: 8 });
  });

  it("fits text with an ellipsis, or nothing when not even that fits", () => {
    expect(fitText("abcdef", 36, "", measure)).toBe("abcdef");
    expect(fitText("abcdef", 30, "", measure)).toBe("abcd…");
    expect(fitText("abcdef", 6, "", measure)).toBe("…");
    expect(fitText("abcdef", 5, "", measure)).toBe("");
  });

  it("carries the right icon", () => {
    expect(titleIcon({ pk: true, autoIncrement: true })).toBe("headerAuto");
    expect(titleIcon({ pk: true })).toBe("headerKey");
    expect(titleIcon({ pk: false, fk: { table: "t" } })).toBe("headerFk");
    expect(titleIcon({ pk: false, fk: null })).toBeNull();
  });

  it("widens the row numbers as Glide does", () => {
    expect([rowMarkerWidth(100), rowMarkerWidth(101), rowMarkerWidth(1001), rowMarkerWidth(10_001)]).toEqual([32, 36, 44, 48]);
  });
});

describe("the corner over the row numbers", () => {
  const draw = (cornerCheckbox: boolean) => {
    let drawn = 0;
    const drawer = columnTitleDrawer({ titleHeight: 34, columnAt: () => undefined, sortOf: () => null, mono: "mono", cornerCheckbox });
    drawer({ columnIndex: -1 } as never, () => { drawn++; });
    return drawn;
  };

  it("keeps Glide's select-all checkbox only where no panel toggle is laid over it", () => {
    expect(draw(true)).toBe(1);
    expect(draw(false)).toBe(0);
  });
});
