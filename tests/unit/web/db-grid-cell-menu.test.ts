import { describe, expect, it } from "bun:test";
import {
  cellMenuEntries, copyAdvancedEntries, isJsonDocument, summarizeSelection, tidyCellMenu,
  type CellMenuActions, type CellMenuCell, type CellMenuEntry, type CellMenuGrid, type CellMenuSelection,
} from "../../../src/web/components/database/grid/cell-menu.ts";
import { COPY_FORMATS, type CopyFormat } from "../../../src/web/components/database/grid/copy-as.ts";
import { ChevronsLeft, ChevronsRight } from "../../../src/web/lib/icons.ts";

/**
 * DBGate's cell menu as data: what a right-click — a long press on a phone — offers for a selection,
 * in DBGate's order, with what the selection does not allow left out and Save, Filter selected value
 * and Clear filter greyed in place.
 */

const noop = () => {};
/** Every action there, each telling what it was asked to do. */
function actions(log: string[] = []): CellMenuActions {
  const say = (what: string) => () => { log.push(what); };
  return {
    openReference: { label: "Open customers.id", onSelect: say("openReference") },
    refresh: say("refresh"),
    fetchAll: say("fetchAll"),
    copy: (f) => { log.push(`copy:${f}`); },
    setCopyFormat: (f) => { log.push(`format:${f}`); },
    switchToForm: say("switchToForm"),
    togglePanel: { open: true, onToggle: say("togglePanel") },
    save: say("save"),
    revertRows: say("revertRows"),
    revertAll: say("revertAll"),
    deleteRows: say("deleteRows"),
    insertRow: say("insertRow"),
    cloneRows: say("cloneRows"),
    setNull: say("setNull"),
    findColumn: say("findColumn"),
    hideColumns: say("hideColumns"),
    filterSelected: say("filterSelected"),
    clearFilter: say("clearFilter"),
    undo: say("undo"),
    redo: say("redo"),
    editCell: say("editCell"),
    addJson: say("addJson"),
    editRowJson: say("editRowJson"),
    viewJson: say("viewJson"),
    saveCellToFile: say("saveCellToFile"),
    showCellData: say("showCellData"),
    openQuery: say("openQuery"),
    exports: [{ kind: "item", label: "CSV file", onSelect: say("export:csv") }],
    generateSql: say("generateSql"),
  };
}
/** A grid where everything can be done. */
const grid = (more: Partial<CellMenuGrid> = {}): CellMenuGrid => ({
  copyFormat: "textWithoutHeaders", mobile: false, editable: true, canChangeRows: true, pending: 2, hasChanges: true,
  canUndo: true, canRedo: true, canFetchAll: true, filters: 1, ...more,
});
/** One text cell that can change, on a row that holds a change. */
const selection = (more: Partial<CellMenuSelection> = {}): CellMenuSelection => ({
  rows: 1, single: { value: "Ann", editable: true }, editable: true, json: true, filterable: true, changed: true, ...more,
});
/** The menu as drawn: a separator as —, a submenu as its label and ▸, a greyed item in brackets. */
const labels = (entries: readonly CellMenuEntry[]) => entries.map((e) =>
  e.kind === "separator" ? "—" : e.kind === "submenu" ? `${e.label} ▸` : e.disabled ? `(${e.label})` : e.label);
const find = (entries: readonly CellMenuEntry[], label: string) => {
  const e = entries.find((x) => x.kind !== "separator" && x.label === label);
  if (!e || e.kind === "separator") throw new Error(`no ${label}`);
  return e;
};

describe("DBGate's order", () => {
  it("offers every item where the selection and the grid allow it, in DBGate's groups", () => {
    expect(labels(cellMenuEntries(selection(), grid(), actions()))).toEqual([
      "Open customers.id", "Refresh", "Fetch all rows", "Copy without headers", "Copy advanced ▸", "Switch to form", "Toggle left panel",
      "—",
      "Save", "Revert row changes", "Revert all changes", "Delete selected rows", "Insert new row", "Clone rows", "Set NULL",
      "—",
      "Find column", "Hide column", "Filter selected value", "Clear filter", "Undo", "Redo",
      "—",
      "Edit cell value", "Add JSON document", "Edit row as JSON document", "View cell as JSON document", "Save cell to file", "Show cell data",
      "—",
      "Open query", "Export ▸", "Generate SQL",
    ]);
  });

  it("runs what each item names", () => {
    const log: string[] = [];
    const entries = cellMenuEntries(selection(), grid(), actions(log));
    for (const e of entries) if (e.kind === "item") e.onSelect();
    expect(log).toEqual([
      "openReference", "refresh", "fetchAll", "copy:textWithoutHeaders", "switchToForm", "togglePanel",
      "save", "revertRows", "revertAll", "deleteRows", "insertRow", "cloneRows", "setNull",
      "findColumn", "hideColumns", "filterSelected", "clearFilter", "undo", "redo",
      "editCell", "addJson", "editRowJson", "viewJson", "saveCellToFile", "showCellData",
      "openQuery", "generateSql",
    ]);
  });

  it("names DBGate's keys, which a phone's sheet leaves out", () => {
    const hints = Object.fromEntries(cellMenuEntries(selection(), grid(), actions())
      .flatMap((e) => (e.kind === "item" && e.hint ? [[e.label, e.hint]] : [])));
    expect(hints).toEqual({
      Refresh: "F5", "Copy without headers": "Mod+C", "Switch to form": "F4", "Toggle left panel": "Mod+L",
      Save: "Mod+S", "Revert row changes": "Mod+U", "Delete selected rows": "Mod+Delete", "Insert new row": "Insert",
      "Clone rows": "Mod+Shift+C", "Set NULL": "Mod+0", "Find column": "Mod+F", "Hide column": "Mod+H",
      "Filter selected value": "Mod+Shift+F", "Clear filter": "Mod+Shift+E", Undo: "Mod+Z", Redo: "Mod+Y",
      "Edit row as JSON document": "Mod+J", "Generate SQL": "Mod+G",
    });
  });

  it("draws the foreign key's item in the accent and Delete as destructive", () => {
    const entries = cellMenuEntries(selection(), grid(), actions());
    expect(find(entries, "Open customers.id")).toMatchObject({ accent: true });
    expect(find(entries, "Delete selected rows")).toMatchObject({ destructive: true });
    expect(entries.filter((e) => e.kind === "item" && (e.accent || e.destructive)).length).toBe(2);
  });
});

describe("what is left out, and what is greyed", () => {
  it("leaves a read-only grid only what reads", () => {
    const entries = cellMenuEntries(
      selection({ single: { value: "Ann", editable: false }, editable: false, changed: false }),
      grid({ editable: false, canChangeRows: false, pending: 0, hasChanges: false, canUndo: false, canRedo: false }),
      actions(),
    );
    expect(labels(entries)).toEqual([
      "Open customers.id", "Refresh", "Fetch all rows", "Copy without headers", "Copy advanced ▸", "Switch to form", "Toggle left panel",
      "—",
      "Find column", "Hide column", "Filter selected value", "Clear filter",
      "—",
      "View cell as JSON document", "Save cell to file", "Show cell data",
      "—",
      "Open query", "Export ▸", "Generate SQL",
    ]);
  });

  it("greys Save with nothing to save, Filter selected value with nothing to filter by, and Clear filter with no filter", () => {
    const entries = cellMenuEntries(selection({ filterable: false }), grid({ pending: 0, filters: 0 }), actions());
    expect(labels(entries)).toContain("(Save)");
    expect(labels(entries)).toContain("(Filter selected value)");
    expect(labels(entries)).toContain("(Clear filter)");
    expect(labels(cellMenuEntries(selection(), grid(), actions())).filter((l) => l.startsWith("("))).toEqual([]);
  });

  it("leaves out Revert with nothing to revert, and Undo and Redo with nothing to undo or redo", () => {
    const quiet = labels(cellMenuEntries(selection({ changed: false }), grid({ hasChanges: false, canUndo: false, canRedo: false }), actions()));
    for (const gone of ["Revert row changes", "Revert all changes", "Undo", "Redo"]) expect(quiet).not.toContain(gone);
    // Rows elsewhere may hold changes the selection does not.
    const others = labels(cellMenuEntries(selection({ changed: false }), grid(), actions()));
    expect(others).not.toContain("Revert row changes");
    expect(others).toContain("Revert all changes");
    expect(labels(cellMenuEntries(selection(), grid({ canUndo: false }), actions()))).toEqual(
      expect.arrayContaining(["Redo"]),
    );
    expect(labels(cellMenuEntries(selection(), grid({ canUndo: false }), actions()))).not.toContain("Undo");
    expect(labels(cellMenuEntries(selection(), grid({ canRedo: false }), actions()))).not.toContain("Redo");
  });

  it("offers Fetch all rows only while there are rows to fetch", () => {
    expect(labels(cellMenuEntries(selection(), grid({ canFetchAll: false }), actions()))).not.toContain("Fetch all rows");
  });

  it("offers a whole column no rows to delete or clone, but a new row still", () => {
    const column = labels(cellMenuEntries(selection({ rows: 0, single: null }), grid(), actions()));
    expect(column).not.toContain("Delete selected rows");
    expect(column).not.toContain("Clone rows");
    expect(column).not.toContain("Edit row as JSON document");
    expect(column).toContain("Insert new row");
    expect(column).toContain("Add JSON document");
  });

  it("offers Set NULL only where a cell can change, and Edit cell value only on one such cell", () => {
    const locked = labels(cellMenuEntries(selection({ single: { value: 1, editable: false }, editable: false }), grid(), actions()));
    expect(locked).not.toContain("Set NULL");
    expect(locked).not.toContain("Edit cell value");
    const several = labels(cellMenuEntries(selection({ single: null, rows: 2 }), grid(), actions()));
    expect(several).toContain("Set NULL");
    expect(several).not.toContain("Edit cell value");
    // Bytes are set to NULL, never typed into.
    const bytes = labels(cellMenuEntries(selection({ single: { value: { $binary: "AAE=", size: 2 }, editable: true } }), grid(), actions()));
    expect(bytes).toContain("Set NULL");
    expect(bytes).not.toContain("Edit cell value");
  });

  it("offers Edit row as JSON document only on one row of a grid that saves", () => {
    expect(labels(cellMenuEntries(selection({ rows: 2, single: null }), grid(), actions()))).not.toContain("Edit row as JSON document");
    expect(labels(cellMenuEntries(selection(), grid({ editable: false }), actions()))).not.toContain("Edit row as JSON document");
  });

  it("offers the JSON view only on JSON, and Save cell to file only on one text or binary value", () => {
    expect(labels(cellMenuEntries(selection({ json: false }), grid(), actions()))).not.toContain("View cell as JSON document");
    const savable = (value: unknown) => labels(cellMenuEntries(selection({ single: { value, editable: true } }), grid(), actions()))
      .includes("Save cell to file");
    expect(savable("text")).toBe(true);
    expect(savable({ $binary: "AAE=", size: 2 })).toBe(true);
    expect(savable(42)).toBe(false);
    expect(savable(null)).toBe(false);
    expect(savable({ a: 1 })).toBe(false);
    expect(labels(cellMenuEntries(selection({ single: null, rows: 2 }), grid(), actions()))).not.toContain("Save cell to file");
  });

  it("leaves out what the grid has no way to do, and a phone the panel it has no room for", () => {
    const bare: CellMenuActions = {
      fetchAll: noop, copy: noop, setCopyFormat: noop, save: noop, revertRows: noop, revertAll: noop, deleteRows: noop,
      insertRow: noop, cloneRows: noop, setNull: noop, undo: noop, redo: noop, showCellData: noop,
    };
    expect(labels(cellMenuEntries(selection(), grid(), bare))).toEqual([
      "Fetch all rows", "Copy without headers", "Copy advanced ▸",
      "—",
      "Save", "Revert row changes", "Revert all changes", "Delete selected rows", "Insert new row", "Clone rows", "Set NULL",
      "—",
      "Undo", "Redo",
      "—",
      "Show cell data",
    ]);
    expect(labels(cellMenuEntries(selection(), grid({ mobile: true }), actions()))).not.toContain("Toggle left panel");
    // An empty Export has nothing to open.
    expect(labels(cellMenuEntries(selection(), grid(), { ...actions(), exports: [] }))).not.toContain("Export ▸");
  });

  it("draws Toggle left panel the way the panel would go", () => {
    expect(find(cellMenuEntries(selection(), grid(), actions()), "Toggle left panel")).toMatchObject({ icon: ChevronsLeft });
    const closed = { ...actions(), togglePanel: { open: false, onToggle: noop } };
    expect(find(cellMenuEntries(selection(), grid(), closed), "Toggle left panel")).toMatchObject({ icon: ChevronsRight });
  });
});

describe("Copy and Copy advanced", () => {
  it("copies in the format Set format chose, named as DBGate names it", () => {
    for (const f of COPY_FORMATS) {
      const log: string[] = [];
      const copy = cellMenuEntries(selection(), grid({ copyFormat: f.id }), actions(log))[3]!;
      expect(copy).toMatchObject({ kind: "item", label: f.label, hint: "Mod+C" });
      if (copy.kind === "item") copy.onSelect();
      expect(log).toEqual([`copy:${f.id}`]);
    }
  });

  it("holds a copy in each format, then the format Ctrl+C copies in", () => {
    const log: string[] = [];
    const sub = copyAdvancedEntries((f) => log.push(`copy:${f}`), (f) => log.push(`format:${f}`));
    expect(labels(sub)).toEqual([
      ...COPY_FORMATS.map((f) => f.label), "—", ...COPY_FORMATS.map((f) => `Set format: ${f.name}`),
    ]);
    for (const e of sub) if (e.kind === "item") e.onSelect();
    const ids = COPY_FORMATS.map((f) => f.id);
    expect(log).toEqual([...ids.map((id: CopyFormat) => `copy:${id}`), ...ids.map((id: CopyFormat) => `format:${id}`)]);
    const advanced = find(cellMenuEntries(selection(), grid(), actions()), "Copy advanced");
    expect(advanced.kind === "submenu" && labels(advanced.entries)).toEqual(labels(sub));
  });
});

describe("separators", () => {
  it("stand only between items: none leading, trailing or doubled where a group came out empty", () => {
    const item = (label: string): CellMenuEntry => ({ kind: "item", label, onSelect: noop });
    const sep: CellMenuEntry = { kind: "separator" };
    expect(labels(tidyCellMenu([sep, item("a"), false, sep, null, sep, item("b"), undefined, sep, sep]))).toEqual(["a", "—", "b"]);
    expect(tidyCellMenu([sep, sep])).toEqual([]);
  });
});

describe("weighing the selection", () => {
  const each = (cells: CellMenuCell[]) => (visit: (cell: CellMenuCell) => void) => cells.forEach(visit);
  const cell = (value: unknown, editable = true, filterable = true): CellMenuCell => ({ value, editable, filterable });

  it("names the one cell alone, and none of several", () => {
    expect(summarizeSelection(each([cell("Ann", false)]), 1, false).single).toEqual({ value: "Ann", editable: false });
    expect(summarizeSelection(each([cell("Ann"), cell("Bo")]), 1, false).single).toBeNull();
    expect(summarizeSelection(each([]), 0, false).single).toBeNull();
  });

  it("can change, and be filtered by, when any cell can", () => {
    const s = summarizeSelection(each([cell(1, false, false), cell(2, true, false), cell(3, false, true)]), 1, false);
    expect([s.editable, s.filterable]).toEqual([true, true]);
    const first = summarizeSelection(each([cell(1, true, true), cell(2, false, false)]), 1, false);
    expect([first.editable, first.filterable]).toEqual([true, true]);
    const none = summarizeSelection(each([cell(1, false, false), cell(2, false, false)]), 1, false);
    expect([none.editable, none.filterable]).toEqual([false, false]);
  });

  it("is JSON only when the one cell selected is a document", () => {
    expect(summarizeSelection(each([cell({ a: 1 })]), 1, false).json).toBe(true);
    expect(summarizeSelection(each([cell([1, 2])]), 1, false).json).toBe(true);
    // The Cell data view shows one document: of several it asks for one cell.
    expect(summarizeSelection(each([cell({ a: 1 }), cell([1, 2])]), 2, false).json).toBe(false);
    expect(summarizeSelection(each([cell("{}")]), 1, false).json).toBe(false);
    expect(summarizeSelection(each([]), 0, false).json).toBe(false);
  });

  it("passes on the rows it lies on and whether they changed", () => {
    expect(summarizeSelection(each([cell(1)]), 3, true)).toMatchObject({ rows: 3, changed: true });
  });

  it("takes a document to be an object or a list as handed over, never text spelling one, nor bytes", () => {
    expect([{}, { a: 1 }, [], [1]].map(isJsonDocument)).toEqual([true, true, true, true]);
    expect([null, undefined, "{}", "[1]", 1, true, { $binary: "AA==", size: 1 }].map(isJsonDocument))
      .toEqual([false, false, false, false, false, false, false]);
  });
});
