import { describe, expect, it } from "bun:test";
import {
  XLSX_MAX_COL_WIDTH,
  XLSX_MIN_COL_WIDTH,
  XLSX_WIDTH_SAMPLE_ROWS,
  columnLetters,
  columnWidths,
  sheetAfterError,
} from "../../../src/web/lib/xlsx-preview-model.ts";

describe("sheetAfterError", () => {
  it("moves to the first sheet only when the sheet is gone", () => {
    expect(sheetAfterError(404, 2)).toBe(0);
  });

  it("keeps the sheet on any other failure", () => {
    expect(sheetAfterError(400, 2)).toBeNull(); // a workbook caught half written
    expect(sheetAfterError(500, 2)).toBeNull();
    expect(sheetAfterError(undefined, 2)).toBeNull(); // network error
  });

  it("does not retry the first sheet forever", () => {
    expect(sheetAfterError(404, 0)).toBeNull();
  });
});

describe("columnWidths", () => {
  it("fits the longest value, held between the limits", () => {
    const w = columnWidths([["a", "2024-03-05 12:00:00", "x".repeat(500)]], 3);
    expect(w[0]).toBe(XLSX_MIN_COL_WIDTH);
    expect(w[1]).toBeGreaterThanOrEqual(19 * 7.2);
    expect(w[1]).toBeLessThan(XLSX_MAX_COL_WIDTH);
    expect(w[2]).toBe(XLSX_MAX_COL_WIDTH);
  });

  it("gives empty and short columns the minimum", () => {
    expect(columnWidths([[null, ""], []], 3)).toEqual([XLSX_MIN_COL_WIDTH, XLSX_MIN_COL_WIDTH, XLSX_MIN_COL_WIDTH]);
  });

  it("looks only at the first rows", () => {
    const rows = Array.from({ length: XLSX_WIDTH_SAMPLE_ROWS }, () => ["ab"]);
    rows.push(["a much longer value past the sample"]);
    expect(columnWidths(rows, 1)).toEqual([XLSX_MIN_COL_WIDTH]);
  });

  it("measures a multi-line value by its widest line", () => {
    expect(columnWidths([["short\nshort"]], 1)).toEqual(columnWidths([["short"]], 1));
  });
});

describe("columnLetters", () => {
  it("names columns as Excel does", () => {
    expect([0, 25, 26, 701, 702].map(columnLetters)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
  });
});
