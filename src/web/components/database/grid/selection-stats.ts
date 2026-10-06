/**
 * What the grid's selection covers, read the way DBGate does: the cells of every selected range,
 * whole columns and whole rows, each counted once. Two or more cells give the Rows / Count / Sum
 * box; the rows they lie on are what Delete row(s) deletes.
 */
import type { GridSelection } from "@glideapps/glide-data-grid";

export interface SelectionStats {
  /** Rows the selected cells lie on. */
  rows: number;
  /** Selected cells. */
  count: number;
  /** Of the cells holding a number; null when none does. */
  sum: number | null;
}

interface Rect { x: number; y: number; width: number; height: number }

function rectsOf(sel: GridSelection): Rect[] {
  if (!sel.current) return [];
  return [sel.current.range, ...sel.current.rangeStack];
}

/** Every index a CompactSelection holds, in order. */
function indicesOf(list: GridSelection["rows"]): number[] {
  const out: number[] = [];
  for (const i of list) out.push(i);
  return out;
}

/** A cell's value as a number when it holds one: a number, or a string that reads as one. */
export function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "" && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(value.trim())) {
    return Number(value);
  }
  return null;
}

/**
 * Visits each selected cell once, as (column, row), within `columns` × `rows`. Visited rather than
 * listed: a whole column of a fetched-all table is a million cells.
 */
export function forEachSelectedCell(sel: GridSelection, columns: number, rows: number, visit: (column: number, row: number) => void) {
  const rects = rectsOf(sel);
  const cols = indicesOf(sel.columns);
  const rowList = indicesOf(sel.rows);
  // Whole columns never share a cell, nor do whole rows; only two ranges, or two kinds, can — and
  // only then is a set worth its memory.
  const kinds = Number(rects.length > 0) + Number(cols.length > 0) + Number(rowList.length > 0);
  const seen = rects.length > 1 || kinds > 1 ? new Set<number>() : null;
  const add = (c: number, r: number) => {
    if (c < 0 || r < 0 || c >= columns || r >= rows) return;
    if (seen) {
      const id = r * columns + c;
      if (seen.has(id)) return;
      seen.add(id);
    }
    visit(c, r);
  };
  for (const rect of rects) {
    for (let r = rect.y; r < rect.y + rect.height; r++) for (let c = rect.x; c < rect.x + rect.width; c++) add(c, r);
  }
  for (const c of cols) for (let r = 0; r < rows; r++) add(c, r);
  for (const r of rowList) for (let c = 0; c < columns; c++) add(c, r);
}

/** Rows / Count / Sum over the selection, or null below two cells. */
export function selectionStats(
  sel: GridSelection, columns: number, rows: number, valueAt: (column: number, row: number) => unknown,
): SelectionStats | null {
  const rowSet = new Set<number>();
  let count = 0;
  let sum = 0;
  let numbers = 0;
  forEachSelectedCell(sel, columns, rows, (c, r) => {
    count++;
    rowSet.add(r);
    const n = numericValue(valueAt(c, r));
    if (n === null) return;
    sum += n;
    numbers++;
  });
  if (count < 2) return null;
  // Floating point adds noise past the tenth decimal (0.1 + 0.2); that is not a digit anyone typed.
  return { rows: rowSet.size, count, sum: numbers ? Math.round(sum * 1e10) / 1e10 : null };
}

/** Whether the selection covers a cell: a right-click there acts on the selection, elsewhere on the cell. */
export function selectionHasCell(sel: GridSelection, column: number, row: number): boolean {
  if (sel.columns.hasIndex(column) || sel.rows.hasIndex(row)) return true;
  return rectsOf(sel).some((r) => column >= r.x && column < r.x + r.width && row >= r.y && row < r.y + r.height);
}

/**
 * What DBGate's copy and Generate SQL take from a selection: the rows its cells lie on by the columns
 * they lie in, each in order — two ranges side by side give one block, cells between them included.
 */
export function selectedBlock(sel: GridSelection, columns: number, rows: number): { rows: number[]; columns: number[] } {
  const rowSet = new Set<number>();
  const colSet = new Set<number>();
  const inRange = (c: number, r: number) => c >= 0 && r >= 0 && c < columns && r < rows;
  for (const rect of rectsOf(sel)) {
    for (let r = rect.y; r < rect.y + rect.height; r++) for (let c = rect.x; c < rect.x + rect.width; c++) {
      if (inRange(c, r)) { rowSet.add(r); colSet.add(c); }
    }
  }
  const wholeCols = indicesOf(sel.columns).filter((c) => c >= 0 && c < columns);
  const wholeRows = indicesOf(sel.rows).filter((r) => r >= 0 && r < rows);
  if (wholeCols.length && rows > 0) {
    for (const c of wholeCols) colSet.add(c);
    for (let r = 0; r < rows; r++) rowSet.add(r);
  }
  if (wholeRows.length && columns > 0) {
    for (const r of wholeRows) rowSet.add(r);
    for (let c = 0; c < columns; c++) colSet.add(c);
  }
  const byIndex = (a: number, b: number) => a - b;
  return { rows: [...rowSet].sort(byIndex), columns: [...colSet].sort(byIndex) };
}

/**
 * The rows Delete row(s) acts on: the ones a selected range or row covers. A whole column selected
 * from its title is not a choice of rows, so it deletes none.
 */
export function selectedRowIndices(sel: GridSelection, rows: number): number[] {
  const set = new Set<number>();
  for (const rect of rectsOf(sel)) for (let r = rect.y; r < rect.y + rect.height; r++) if (r < rows) set.add(r);
  for (const r of indicesOf(sel.rows)) if (r < rows) set.add(r);
  return [...set].sort((a, b) => a - b);
}
