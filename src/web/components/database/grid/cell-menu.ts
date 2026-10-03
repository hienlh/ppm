/**
 * DBGate's cell menu (`registerMenu` in DataGridCore), as data: what a right-click — a long press on
 * a phone — offers for the selection, in DBGate's order. As in DBGate, what the selection does not
 * allow is left out rather than greyed; Save, Filter selected value and Clear filter stay in place,
 * greyed, as DBGate keeps them. PPM's Open <table>.<column> on a foreign key leads.
 *
 * Not offered, each for a reason: Map and Edit selection as table (PPM has no tab to put them in),
 * Copy as Mongo INSERTs (no MongoDB), Load cell from file (DBGate's desktop app only), View row as
 * JSON document (DBGate's for collections, whose rows are documents) and Open array as table (a
 * table of its own needs a tab type PPM does not have).
 *
 * Shortcuts are written as combos (`Mod+C`), drawn by the menu, which a phone's sheet leaves out.
 */
import type { ElementType } from "react";
import {
  ArrowDownToLine, ArrowRightFromLine, ChevronsLeft, ChevronsRight, Clipboard, ClipboardList, Code, Copy, Download, ExternalLink, EyeOff,
  FileCode, FilePen, FilePlus, Filter, Form, ListFilter, Minus, PanelRight, Pencil, Plus, Redo2, RefreshCw, RotateCcw, Save, Search,
  SquareTerminal, Undo2, XCircle,
} from "@/lib/icons";
import { COPY_FORMATS, copyFormatLabel, type CopyFormat } from "./copy-as";
import { isBinaryValue } from "./cell-display";

export type CellMenuEntry =
  | {
    kind: "item"; label: string; onSelect: () => void; icon?: ElementType; hint?: string;
    disabled?: boolean; destructive?: boolean;
    /** Drawn in the accent: an item that opens somewhere else. */
    accent?: boolean;
  }
  | { kind: "submenu"; label: string; icon?: ElementType; entries: readonly CellMenuEntry[] }
  | { kind: "separator" };

/** What the selection covers, as the menu's items depend on it. */
export interface CellMenuSelection {
  /** Rows it lies on. */
  rows: number;
  /** The cell, when one alone is selected. */
  single: { value: unknown; editable: boolean } | null;
  /** Some cell in it can change. */
  editable: boolean;
  /** The one cell selected holds a JSON object or array: what View cell as JSON document shows. */
  json: boolean;
  /** Some value in it can be filtered on. */
  filterable: boolean;
  /** Its rows hold changes that Revert row changes would take back. */
  changed: boolean;
}

/** One selected cell, as the menu weighs it. */
export interface CellMenuCell {
  /** What the cell shows now. */
  value: unknown;
  editable: boolean;
  filterable: boolean;
}

/** DBGate's JSON document: an object or a list, as the database handed it — not text that spells one. */
export function isJsonDocument(value: unknown): boolean {
  return value !== null && typeof value === "object" && !isBinaryValue(value);
}

/**
 * The selection as the menu needs it, from `forEachCell` visiting each selected cell once — visited
 * rather than listed, since a whole column of a fetched-all table is a great many cells.
 */
export function summarizeSelection(
  forEachCell: (visit: (cell: CellMenuCell) => void) => void, rows: number, changed: boolean,
): CellMenuSelection {
  let count = 0;
  let first: CellMenuCell | undefined;
  let editable = false;
  let filterable = false;
  let json = true;
  forEachCell((cell) => {
    if (count++ === 0) first = cell;
    editable ||= cell.editable;
    filterable ||= cell.filterable;
    json &&= isJsonDocument(cell.value);
  });
  return {
    rows,
    single: count === 1 && first ? { value: first.value, editable: first.editable } : null,
    editable,
    // The Cell data view shows one document expanded: of several it says to select one.
    json: count === 1 && json,
    filterable,
    changed,
  };
}

/** What the grid allows, whatever is selected. */
export interface CellMenuGrid {
  copyFormat: CopyFormat;
  /** A phone's sheet: there is no panel beside the grid to toggle. */
  mobile: boolean;
  /** Cells can change and be saved. */
  editable: boolean;
  /** Rows can be added and deleted. */
  canChangeRows: boolean;
  /** Rows Save would write. */
  pending: number;
  hasChanges: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canFetchAll: boolean;
  /** Filters in force, for Clear filter. */
  filters: number;
}

/** What the items do; an item whose action is absent is not there. */
export interface CellMenuActions {
  openReference?: { label: string; onSelect: () => void };
  refresh?: () => void;
  fetchAll: () => void;
  copy: (format: CopyFormat) => void;
  setCopyFormat: (format: CopyFormat) => void;
  switchToForm?: () => void;
  togglePanel?: { open: boolean; onToggle: () => void };
  save: () => void;
  revertRows: () => void;
  revertAll: () => void;
  deleteRows: () => void;
  insertRow: () => void;
  cloneRows: () => void;
  setNull: () => void;
  findColumn?: () => void;
  hideColumns?: () => void;
  filterSelected?: () => void;
  clearFilter?: () => void;
  undo: () => void;
  redo: () => void;
  editCell?: () => void;
  addJson?: () => void;
  editRowJson?: () => void;
  viewJson?: () => void;
  saveCellToFile?: () => void;
  showCellData: () => void;
  openQuery?: () => void;
  /** The Export submenu's entries. */
  exports?: readonly CellMenuEntry[];
  generateSql?: () => void;
}

const SEPARATOR: CellMenuEntry = { kind: "separator" };

/** Separators only between items: none leading, trailing or doubled where a group came out empty. */
export function tidyCellMenu(entries: readonly (CellMenuEntry | false | null | undefined)[]): CellMenuEntry[] {
  const out: CellMenuEntry[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (e.kind === "separator" && (out.length === 0 || out.at(-1)!.kind === "separator")) continue;
    out.push(e);
  }
  while (out.at(-1)?.kind === "separator") out.pop();
  return out;
}

/** DBGate's Copy advanced: a copy in each format, then the format Ctrl+C copies in. */
export function copyAdvancedEntries(copy: (format: CopyFormat) => void, setFormat: (format: CopyFormat) => void): CellMenuEntry[] {
  return [
    ...COPY_FORMATS.map((f): CellMenuEntry => ({ kind: "item", label: f.label, onSelect: () => copy(f.id) })),
    SEPARATOR,
    ...COPY_FORMATS.map((f): CellMenuEntry => ({ kind: "item", label: `Set format: ${f.name}`, onSelect: () => setFormat(f.id) })),
  ];
}

const item = (label: string, onSelect: () => void, more: Omit<Extract<CellMenuEntry, { kind: "item" }>, "kind" | "label" | "onSelect"> = {}): CellMenuEntry =>
  ({ kind: "item", label, onSelect, ...more });

export function cellMenuEntries(sel: CellMenuSelection, grid: CellMenuGrid, act: CellMenuActions): CellMenuEntry[] {
  const single = sel.single;
  const savable = !!single && (typeof single.value === "string" || isBinaryValue(single.value));
  return tidyCellMenu([
    act.openReference && item(act.openReference.label, act.openReference.onSelect, { icon: ExternalLink, accent: true }),
    act.refresh && item("Refresh", act.refresh, { icon: RefreshCw, hint: "F5" }),
    grid.canFetchAll && item("Fetch all rows", act.fetchAll, { icon: ArrowDownToLine }),
    item(copyFormatLabel(grid.copyFormat), () => act.copy(grid.copyFormat), { icon: Clipboard, hint: "Mod+C" }),
    { kind: "submenu", label: "Copy advanced", icon: ClipboardList, entries: copyAdvancedEntries(act.copy, act.setCopyFormat) },
    act.switchToForm && item("Switch to form", act.switchToForm, { icon: Form, hint: "F4" }),
    act.togglePanel && !grid.mobile
      && item("Toggle left panel", act.togglePanel.onToggle, { icon: act.togglePanel.open ? ChevronsLeft : ChevronsRight, hint: "Mod+L" }),
    SEPARATOR,
    grid.editable && item("Save", act.save, { icon: Save, hint: "Mod+S", disabled: grid.pending === 0 }),
    grid.editable && sel.changed && item("Revert row changes", act.revertRows, { icon: RotateCcw, hint: "Mod+U" }),
    grid.editable && grid.hasChanges && item("Revert all changes", act.revertAll, { icon: Undo2 }),
    grid.canChangeRows && sel.rows > 0 && item("Delete selected rows", act.deleteRows, { icon: Minus, hint: "Mod+Delete", destructive: true }),
    grid.canChangeRows && item("Insert new row", act.insertRow, { icon: Plus, hint: "Insert" }),
    grid.canChangeRows && sel.rows > 0 && item("Clone rows", act.cloneRows, { icon: Copy, hint: "Mod+Shift+C" }),
    sel.editable && item("Set NULL", act.setNull, { icon: XCircle, hint: "Mod+0" }),
    SEPARATOR,
    act.findColumn && item("Find column", act.findColumn, { icon: Search, hint: "Mod+F" }),
    act.hideColumns && item("Hide column", act.hideColumns, { icon: EyeOff, hint: "Mod+H" }),
    act.filterSelected && item("Filter selected value", act.filterSelected, { icon: Filter, hint: "Mod+Shift+F", disabled: !sel.filterable }),
    act.clearFilter && item("Clear filter", act.clearFilter, { icon: ListFilter, hint: "Mod+Shift+E", disabled: grid.filters === 0 }),
    grid.canUndo && item("Undo", act.undo, { icon: Undo2, hint: "Mod+Z" }),
    grid.canRedo && item("Redo", act.redo, { icon: Redo2, hint: "Mod+Y" }),
    SEPARATOR,
    // Bytes are not text to type into.
    single?.editable && !isBinaryValue(single.value) && act.editCell && item("Edit cell value", act.editCell, { icon: Pencil }),
    grid.canChangeRows && act.addJson && item("Add JSON document", act.addJson, { icon: FilePlus }),
    grid.editable && sel.rows === 1 && act.editRowJson && item("Edit row as JSON document", act.editRowJson, { icon: FilePen, hint: "Mod+J" }),
    sel.json && act.viewJson && item("View cell as JSON document", act.viewJson, { icon: FileCode }),
    savable && act.saveCellToFile && item("Save cell to file", act.saveCellToFile, { icon: Download }),
    item("Show cell data", act.showCellData, { icon: PanelRight }),
    SEPARATOR,
    act.openQuery && item("Open query", act.openQuery, { icon: SquareTerminal }),
    !!act.exports?.length && { kind: "submenu", label: "Export", icon: ArrowRightFromLine, entries: act.exports },
    act.generateSql && item("Generate SQL", act.generateSql, { icon: Code, hint: "Mod+G" }),
  ]);
}
