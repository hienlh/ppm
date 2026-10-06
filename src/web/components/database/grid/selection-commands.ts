/**
 * What DBGate's commands on the selection make of it: Filter selected value's filters, Hide column's
 * columns and Save cell to file's file. Cells are visited one at a time, as the cell menu weighs them:
 * a whole column of a fetched-all table is a great many cells.
 */
import type { GridSelection } from "@glideapps/glide-data-grid";
import type { ColumnKind } from "../../../../shared/db-column-kind";
import { formatByteSize, isBinaryValue } from "./cell-display";
import { bytesRead, imageType } from "./cell-data-formats";
import { TAB_FILTER_CAPS } from "./grid-filters";
import { canChooseValues, pickedValuesFilter, valueKey } from "./value-filter-text";

/** One selected cell: its column, and what it shows now. */
export interface SelectedValue {
  column: string;
  value: unknown;
}

export type SelectedValueFilters =
  | { ok: true; filters: ReadonlyMap<string, string> }
  /** Too many values in `column` for one filter: the tab keeps a filter's text only up to its cap. */
  | { ok: false; column: string };

/**
 * Filter selected value: each column of the selection filtered to the values selected in it, every
 * value once, in the order they were met — DBGate writes a value again for each cell holding it.
 * What no filter can spell is passed over: a column of bytes or JSON, and a new row's value nobody
 * gave it.
 */
export function selectedValueFilters(
  forEachValue: (visit: (cell: SelectedValue) => void) => void,
  kindOf: (column: string) => ColumnKind | undefined,
): SelectedValueFilters {
  const picked = new Map<string, { kind: ColumnKind; seen: Set<string>; values: unknown[] }>();
  forEachValue(({ column, value }) => {
    const kind = kindOf(column);
    if (!kind || !canChooseValues(kind) || value === undefined || isBinaryValue(value)) return;
    let entry = picked.get(column);
    if (!entry) {
      entry = { kind, seen: new Set(), values: [] };
      picked.set(column, entry);
    }
    const key = valueKey(value);
    if (entry.seen.has(key)) return;
    entry.seen.add(key);
    entry.values.push(value);
  });
  const filters = new Map<string, string>();
  for (const [column, { kind, values }] of picked) {
    const text = pickedValuesFilter(kind, values);
    // Applied, then dropped when the tab is opened again: better not set at all.
    if (text.length > TAB_FILTER_CAPS.text) return { ok: false, column };
    filters.set(column, text);
  }
  return { ok: true, filters };
}

/**
 * Hide column's columns: those a selected range or a whole column lies in, each once, left to right.
 * Not whole rows — a row selected from its number lies in every column, and hiding them all leaves
 * nothing to see.
 */
export function selectedColumnIndices(sel: GridSelection, columns: number): number[] {
  const found = new Set<number>();
  const add = (c: number) => { if (c >= 0 && c < columns) found.add(c); };
  if (sel.current) {
    for (const rect of [sel.current.range, ...sel.current.rangeStack]) {
      for (let c = rect.x; c < rect.x + rect.width; c++) add(c);
    }
  }
  for (const c of sel.columns) add(c);
  return [...found].sort((a, b) => a - b);
}

/** What a file is named for the picture its bytes begin as. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/bmp": "bmp", "image/x-icon": "ico", "image/avif": "avif",
};

/** Characters no file name may hold on one system or another. */
const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;

/** `users-avatar`: the table and the column, as a file name every system takes. */
export function cellFileBase(table: string | null | undefined, column: string): string {
  const base = (table ? `${table}-${column}` : column).replace(UNSAFE_NAME, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 120);
  return base || "cell";
}

export type CellFile =
  | { ok: true; name: string; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: string };

/** The file a cell's value is saved as: text as a `.txt`, bytes named for the picture they begin as and `.bin` otherwise. */
export function cellFileName(value: unknown, base: string): string {
  if (typeof value === "string") return `${base}.txt`;
  const type = isBinaryValue(value) ? imageType(value) : null;
  return `${base}.${(type && IMAGE_EXTENSIONS[type]) || "bin"}`;
}

/**
 * Save cell to file: text in UTF-8, bytes as they are, named by `cellFileName`. Bytes only partly
 * read with the row are refused: the file would be cut short — a table's grid reads those whole
 * from the server instead.
 */
export function cellFile(value: unknown, base: string): CellFile {
  if (typeof value === "string") return { ok: true, name: cellFileName(value, base), bytes: new TextEncoder().encode(value) };
  if (!isBinaryValue(value)) return { ok: false, reason: "Only text and bytes can be saved to a file" };
  if (value.truncated) {
    return {
      ok: false,
      reason: `Only the first ${formatByteSize(bytesRead(value))} of its ${formatByteSize(value.size)} came with the row`,
    };
  }
  let raw: string;
  try {
    raw = atob(value.$binary);
  } catch {
    return { ok: false, reason: "Its bytes could not be read" };
  }
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return { ok: true, name: cellFileName(value, base), bytes };
}
