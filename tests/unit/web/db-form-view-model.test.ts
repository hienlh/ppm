import { describe, expect, test } from "bun:test";
import {
  FORM_ROW_HEIGHT,
  cellOfField,
  clampFormCell,
  columnNameMatches,
  fieldOfCell,
  fieldsPerColumn,
  formChunks,
  formCopyText,
  formDisplayText,
  formEditText,
  formRowLabel,
  isValueCell,
  moveFormCell,
  nameCapitals,
  navigateFormRow,
  parseFormText,
  type FormCell,
  type FormCursorContext,
} from "../../../src/web/components/database/grid/form-view-model";
import type { RowCountView } from "../../../src/web/components/database/glide-grid-types";

describe("form layout", () => {
  test("fits as many 30px fields as the height holds above the 22px row label", () => {
    expect(FORM_ROW_HEIGHT).toBe(30);
    expect(fieldsPerColumn(22 + 30 * 7)).toBe(7);
    expect(fieldsPerColumn(22 + 30 * 7 - 1)).toBe(6);
    expect(fieldsPerColumn(22 + 30 * 7 + 29)).toBe(7);
  });

  test("always holds one field, or nothing could be shown", () => {
    expect(fieldsPerColumn(0)).toBe(1);
    expect(fieldsPerColumn(-40)).toBe(1);
    expect(fieldsPerColumn(Number.NaN)).toBe(1);
    expect(fieldsPerColumn(Number.POSITIVE_INFINITY)).toBe(1);
  });

  test("splits the fields into pairs of names and values, the last one short", () => {
    expect(formChunks(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(formChunks(["a", "b"], 5)).toEqual([["a", "b"]]);
    expect(formChunks([], 3)).toEqual([]);
    // A height that holds nothing still lays out one field a pair.
    expect(formChunks(["a", "b"], 0)).toEqual([["a"], ["b"]]);
  });

  test("puts field i at row i % per of pair i / per, its value one column right of its name", () => {
    expect(cellOfField(0, 4)).toEqual([0, 1]);
    expect(cellOfField(5, 4)).toEqual([1, 3]);
    expect(cellOfField(5, 4, true)).toEqual([1, 2]);
    expect(cellOfField(9, 4)).toEqual([1, 5]);
    for (let field = 0; field < 13; field++) {
      expect(fieldOfCell(cellOfField(field, 4), 4)).toBe(field);
      expect(fieldOfCell(cellOfField(field, 4, true), 4)).toBe(field);
    }
    expect(isValueCell([0, 1])).toBe(true);
    expect(isValueCell([0, 2])).toBe(false);
  });
});

describe("keeping the cursor on the form", () => {
  // 10 fields, 4 a pair: pairs of 4, 4 and 2, columns 0 to 5.
  test("stops on the last pair's values past the last pair", () => {
    expect(clampFormCell([0, 9], 10, 4)).toEqual([0, 5]);
  });

  test("stops on a short last pair's last field", () => {
    expect(clampFormCell([3, 5], 10, 4)).toEqual([1, 5]);
    expect(clampFormCell([3, 4], 10, 4)).toEqual([1, 4]);
  });

  test("stops at the first row and column", () => {
    expect(clampFormCell([-1, -1], 10, 4)).toEqual([0, 0]);
  });

  test("leaves a cell inside the form where it is", () => {
    expect(clampFormCell([2, 3], 10, 4)).toEqual([2, 3]);
  });

  test("a table with no columns has only its first value", () => {
    expect(clampFormCell([3, 4], 0, 4)).toEqual([0, 1]);
  });
});

describe("the Column name filter", () => {
  test("matches inside a name, ignoring case", () => {
    expect(columnNameMatches("mail", "email_address")).toBe(true);
    expect(columnNameMatches("MAIL", "email_address")).toBe(false);
    expect(columnNameMatches("Mail", "email_address")).toBe(true);
    expect(columnNameMatches("phone", "email_address")).toBe(false);
  });

  test("needs every word separated by spaces", () => {
    expect(columnNameMatches("email addr", "email_address")).toBe(true);
    expect(columnNameMatches("email phone", "email_address")).toBe(false);
  });

  test("takes any alternative separated by commas", () => {
    expect(columnNameMatches("phone, mail", "email_address")).toBe(true);
    expect(columnNameMatches("phone,fax", "email_address")).toBe(false);
  });

  test("reads a word in capitals as the capitals of the name's words, in order", () => {
    expect(columnNameMatches("CA", "created_at")).toBe(true);
    expect(columnNameMatches("AC", "created_at")).toBe(false);
    expect(columnNameMatches("UID", "userID")).toBe(true);
    expect(columnNameMatches("UI", "userID")).toBe(true);
    expect(columnNameMatches("XHR", "XMLHttpRequest")).toBe(true);
    expect(columnNameMatches("CA", "category")).toBe(false);
  });

  test("an empty filter matches everything, an empty name nothing", () => {
    expect(columnNameMatches("", "id")).toBe(true);
    expect(columnNameMatches("   ", "id")).toBe(true);
    expect(columnNameMatches("id", "")).toBe(false);
    expect(columnNameMatches(" , ", "id")).toBe(false);
  });

  test("finds the words of a name wherever it breaks them", () => {
    expect(nameCapitals("created_at")).toBe("CA");
    expect(nameCapitals("userID")).toBe("UID");
    expect(nameCapitals("XMLHttpRequest")).toBe("XMLHR");
    // Digits break words but are not capitals.
    expect(nameCapitals("address2line")).toBe("AL");
    expect(nameCapitals("order-total amount")).toBe("OTA");
  });
});

describe("moving the cursor", () => {
  const names = ["id", "email", "name", "created_at", "updated_at", "user_id", "total", "status", "note", "paid"];
  const ctx = (nameFilter = ""): FormCursorContext => ({ fieldCount: names.length, perColumn: 4, nameFilter, names });
  const move = (cell: FormCell, key: string, filter = "", ctrl = false) => moveFormCell(cell, key, ctrl, ctx(filter));

  test("arrows move one cell, kept on the form", () => {
    expect(move([1, 1], "ArrowLeft")).toEqual([1, 0]);
    expect(move([1, 1], "ArrowRight")).toEqual([1, 2]);
    expect(move([1, 1], "ArrowUp")).toEqual([0, 1]);
    expect(move([1, 1], "ArrowDown")).toEqual([2, 1]);
    expect(move([0, 0], "ArrowUp")).toEqual([0, 0]);
    expect(move([3, 1], "ArrowDown")).toEqual([3, 1]);
    // The last pair holds two fields: going right from row 3 lands on its last.
    expect(move([3, 3], "ArrowRight")).toEqual([1, 4]);
  });

  test("Ctrl+← and Ctrl+→ go to the first and the last column", () => {
    expect(move([2, 3], "ArrowLeft", "", true)).toEqual([2, 0]);
    expect(move([1, 1], "ArrowRight", "", true)).toEqual([1, 5]);
    expect(move([3, 1], "ArrowRight", "", true)).toEqual([1, 5]);
    expect(move([1, 1], "ArrowUp", "", true)).toBeNull();
  });

  test("Page Up and Page Down go to the pair's top and bottom", () => {
    expect(move([2, 3], "PageUp")).toEqual([0, 3]);
    expect(move([0, 3], "PageDown")).toEqual([3, 3]);
    expect(move([0, 5], "PageDown")).toEqual([1, 5]);
  });

  test("Home goes to the first name and End to the last value", () => {
    expect(move([2, 3], "Home")).toEqual([0, 0]);
    expect(move([0, 0], "End")).toEqual([1, 5]);
  });

  test("other keys do not move it", () => {
    expect(move([1, 1], "a")).toBeNull();
    expect(move([1, 1], "Enter")).toBeNull();
  });

  test("with a filter typed, ↑ and ↓ on a name go to the matching names, wrapping round", () => {
    // `_at` matches created_at (3) and updated_at (4).
    expect(move(cellOfField(0, 4, true), "ArrowDown", "_at")).toEqual(cellOfField(3, 4, true));
    expect(move(cellOfField(3, 4, true), "ArrowDown", "_at")).toEqual(cellOfField(4, 4, true));
    expect(move(cellOfField(4, 4, true), "ArrowDown", "_at")).toEqual(cellOfField(3, 4, true));
    expect(move(cellOfField(3, 4, true), "ArrowUp", "_at")).toEqual(cellOfField(4, 4, true));
    // From the second pair on, the field itself, not row `index % fieldCount` of the pair.
    expect(move(cellOfField(4, 4, true), "ArrowUp", "_at")).toEqual(cellOfField(3, 4, true));
    expect(move(cellOfField(5, 4, true), "ArrowDown", "paid")).toEqual(cellOfField(9, 4, true));
  });

  test("with nothing matching, ↓ goes to the last name and ↑ to the first", () => {
    expect(move(cellOfField(2, 4, true), "ArrowDown", "zzz")).toEqual(cellOfField(9, 4, true));
    expect(move(cellOfField(6, 4, true), "ArrowUp", "zzz")).toEqual(cellOfField(0, 4, true));
  });

  test("a filter does not change ↑ and ↓ on a value, nor ← and →", () => {
    expect(move([1, 1], "ArrowDown", "_at")).toEqual([2, 1]);
    expect(move([1, 0], "ArrowRight", "_at")).toEqual([1, 1]);
  });

  test("a form with no fields has nowhere to go", () => {
    expect(moveFormCell([0, 1], "ArrowDown", false, { fieldCount: 0, perColumn: 4, nameFilter: "", names: [] })).toBeNull();
  });
});

describe("First · Previous · Next · Last", () => {
  test("stay among the rows", () => {
    expect(navigateFormRow(3, "first", 10)).toBe(0);
    expect(navigateFormRow(3, "previous", 10)).toBe(2);
    expect(navigateFormRow(0, "previous", 10)).toBe(0);
    expect(navigateFormRow(3, "next", 10)).toBe(4);
    expect(navigateFormRow(9, "next", 10)).toBe(9);
    expect(navigateFormRow(3, "last", 10)).toBe(9);
  });

  test("bring a row past the end back to the last", () => {
    expect(navigateFormRow(14, "previous", 10)).toBe(9);
    expect(navigateFormRow(-3, "next", 10)).toBe(0);
  });

  test("with no rows there is only the first place", () => {
    expect(navigateFormRow(3, "last", 0)).toBe(0);
    expect(navigateFormRow(3, "next", 0)).toBe(0);
  });
});

describe("the row label", () => {
  const view = (total: RowCountView["total"], counting = false): RowCountView => ({ text: "", counting, canCountExactly: false, total });

  test("counts from one against the table's own total", () => {
    expect(formRowLabel(1, 37, 37, view({ kind: "exact", count: 37 }))).toBe("Row: 2 / 37");
    expect(formRowLabel(0, 50, 50, view({ kind: "exact", count: 1234 }))).toBe(`Row: 1 / ${(1234).toLocaleString()}`);
  });

  test("never says fewer rows than it holds", () => {
    expect(formRowLabel(0, 60, 60, view({ kind: "exact", count: 40 }))).toBe("Row: 1 / 60");
  });

  test("says an estimate, Many, or more to come", () => {
    expect(formRowLabel(0, 50, 50, view({ kind: "estimate", count: 9000 }))).toBe(`Row: 1 / ~${(9000).toLocaleString()}`);
    expect(formRowLabel(0, 50, 50, view({ kind: "many" }))).toBe("Row: 1 / Many");
    expect(formRowLabel(0, 50, 50, view({ kind: "atLeast", count: 50 }))).toBe("Row: 1 / 50+");
    expect(formRowLabel(0, 50, 50, view({ kind: "atLeast", count: 50 }, true))).toBe("Loading row count...");
  });

  test("says ??? where nothing is known about the total", () => {
    expect(formRowLabel(0, 5, 5, null)).toBe("Row: 1 / ???");
    expect(formRowLabel(0, 5, 5, view(undefined))).toBe("Row: 1 / ???");
  });

  test("names a new row by its place among the new rows", () => {
    expect(formRowLabel(5, 7, 5, view({ kind: "exact", count: 5 }))).toBe("New row 1");
    expect(formRowLabel(6, 7, 5, view({ kind: "exact", count: 5 }))).toBe("New row 2");
  });

  test("says No data with no rows, or a row that is not there", () => {
    expect(formRowLabel(0, 0, 0, view({ kind: "exact", count: 0 }))).toBe("No data");
    expect(formRowLabel(3, 3, 3, view({ kind: "exact", count: 3 }))).toBe("No data");
    expect(formRowLabel(-1, 3, 3, view({ kind: "exact", count: 3 }))).toBe("No data");
  });
});

describe("what a field's editor puts in", () => {
  test("puts NULL in for an emptied field, as a cell cleared in the grid", () => {
    for (const kind of ["number", "boolean", "text"] as const) expect(parseFormText("", kind)).toEqual({ ok: true, value: null });
  });

  test("reads a number column's decimal numbers, and nothing JavaScript would also call a number", () => {
    expect(parseFormText("42", "number")).toEqual({ ok: true, value: 42 });
    expect(parseFormText(" -3.5 ", "number")).toEqual({ ok: true, value: -3.5 });
    expect(parseFormText(".5", "number")).toEqual({ ok: true, value: 0.5 });
    expect(parseFormText("7.", "number")).toEqual({ ok: true, value: 7 });
    expect(parseFormText("1e3", "number")).toEqual({ ok: true, value: 1000 });
    expect(parseFormText("+2", "number")).toEqual({ ok: true, value: 2 });
    for (const text of ["0x10", "0b11", "1_000", "abc", "1,5", "Infinity", "NaN", "1e999", " ", "1 2", "--1"]) {
      expect([text, parseFormText(text, "number")]).toEqual([text, { ok: false, error: "Not a number" }]);
    }
  });

  test("keeps every digit of a number too long for a JavaScript number, as typed", () => {
    expect(parseFormText("9007199254740993", "number")).toEqual({ ok: true, value: "9007199254740993" });
    expect(parseFormText(" -12345678901234567890 ", "number")).toEqual({ ok: true, value: "-12345678901234567890" });
    expect(parseFormText("9007199254740993.5", "number")).toEqual({ ok: true, value: "9007199254740993.5" });
    expect(parseFormText("0.1234567890123456", "number")).toEqual({ ok: true, value: "0.1234567890123456" });
    // The largest safe integer is still a number, and so is a decimal of 15 significant digits.
    expect(parseFormText("9007199254740991", "number")).toEqual({ ok: true, value: 9007199254740991 });
    expect(parseFormText("1234567890.12345", "number")).toEqual({ ok: true, value: 1234567890.12345 });
    expect(parseFormText("0.000123456789012345", "number")).toEqual({ ok: true, value: 0.000123456789012345 });
    expect(parseFormText("1.50000000000000000000", "number")).toEqual({ ok: true, value: 1.5 });
  });

  test("reads true and false the ways the filter reads them, and refuses anything else", () => {
    for (const text of ["true", "TRUE", "t", "1", " True "]) expect(parseFormText(text, "boolean")).toEqual({ ok: true, value: true });
    for (const text of ["false", "F", "0"]) expect(parseFormText(text, "boolean")).toEqual({ ok: true, value: false });
    for (const text of ["yes", "2", "tru"]) expect(parseFormText(text, "boolean")).toEqual({ ok: false, error: "Not true or false" });
  });

  test("puts text in as typed, spaces and all", () => {
    expect(parseFormText("  hi  ", "text")).toEqual({ ok: true, value: "  hi  " });
    expect(parseFormText("0x10", "text")).toEqual({ ok: true, value: "0x10" });
  });
});

describe("what a field shows, edits and copies", () => {
  const bytes = { $binary: "AAEC", size: 3 };

  test("opens the editor empty on NULL, objects as JSON, anything else as its text", () => {
    expect(formEditText(null)).toBe("");
    expect(formEditText(undefined)).toBe("");
    expect(formEditText({ a: [1, "x"] })).toBe('{"a":[1,"x"]}');
    expect(formEditText(12.5)).toBe("12.5");
    expect(formEditText(false)).toBe("false");
    expect(formEditText("")).toBe("");
  });

  test("shows DBGate's (NULL) and (No Field), bytes as their size, objects as JSON", () => {
    expect(formDisplayText(null)).toBe("(NULL)");
    expect(formDisplayText(undefined)).toBe("(No Field)");
    expect(formDisplayText(bytes)).toBe("3 bytes · 00 01 02");
    expect(formDisplayText([1, 2])).toBe("[1,2]");
    expect(formDisplayText("x")).toBe("x");
  });

  test("copies nothing for NULL, as the grid copies a cell", () => {
    expect(formCopyText(null)).toBe("");
    expect(formCopyText(undefined)).toBe("");
    expect(formCopyText(bytes)).toBe("3 bytes · 00 01 02");
    expect(formCopyText({ a: 1 })).toBe('{"a":1}');
    expect(formCopyText(7)).toBe("7");
  });
});
