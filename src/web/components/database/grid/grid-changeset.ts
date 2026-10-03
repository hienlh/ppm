/**
 * DBGate's change set for one grid: every changed cell, new row and row marked for deletion waits
 * here until Save writes them in one transaction, and every step can be undone. Pure, so the rules
 * are tested on their own; `use-changeset.ts` keeps it in React state.
 *
 * A row is named by its id — its key's value, or for a key of several columns the hidden field
 * holding them as one — and a cell by `${rowId}:${column}`, as the grid has always named them. New
 * rows get ids of their own (`__new_…`). A cell of a new row that nothing was put in is DBGate's
 * (No Field): it stays out of the INSERT, so the database fills it in.
 */
import type { ChangesetUpdate, RowKey } from "../../../../shared/db-changeset";
import { isBinaryValue } from "./cell-display";
import { rowKeyOf, type GridChanges } from "../glide-grid-types";

export const NEW_ROW_PREFIX = "__new_";

export function isNewRowId(rowId: string): boolean {
  return rowId.startsWith(NEW_ROW_PREFIX);
}

/** A changed cell: a saved row's, with the key that finds the row and what the cell held when read; or a new row's value. */
export interface PendingEdit {
  /** The row's id, as the grid's key field holds it. */
  pkVal: unknown;
  col: string;
  newVal: unknown;
  /** Unset on new rows. */
  key?: RowKey;
  original?: unknown;
}

export interface GridChangeset {
  /** Changed cells, by `${rowId}:${column}`. */
  readonly cells: ReadonlyMap<string, PendingEdit>;
  /** New rows' ids, in the order they were added: under the rows read, in this order. */
  readonly inserted: readonly string[];
  /** Saved rows marked for deletion, by row id, with the key that deletes each. */
  readonly deleted: ReadonlyMap<string, RowKey>;
}

export const EMPTY_CHANGESET: GridChangeset = { cells: new Map(), inserted: [], deleted: new Map() };

export const cellId = (rowId: unknown, column: string): string => `${rowId}:${column}`;

/** One cell to change: the row as it was read (its key and the cell's earlier value come from it), and the new value. */
export interface CellChange {
  row: Readonly<Record<string, unknown>>;
  column: string;
  value: unknown;
}

/** Equal as the database will see them: a value and its JSON twin are the same, "5" and 5 are not. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Change cells. A row marked for deletion is left alone — it is to be deleted, not changed — and
 * a saved row's cell given back the value it was read with is no longer a change. Answers the same
 * change set when nothing changed, so nothing is recorded to undo.
 */
export function editCells(cs: GridChangeset, changes: readonly CellChange[], pkCol: string, keyCols: readonly string[]): GridChangeset {
  let cells: Map<string, PendingEdit> | null = null;
  for (const change of changes) {
    const pkVal = change.row[pkCol];
    const rowId = String(pkVal);
    if (cs.deleted.has(rowId)) continue;
    // A cleared number comes back from the grid as undefined: in the database that is NULL.
    const value = change.value === undefined ? null : change.value;
    const id = cellId(pkVal, change.column);
    const current = (cells ?? cs.cells).get(id);
    if (isNewRowId(rowId)) {
      if (current && sameValue(current.newVal, value)) continue;
      cells ??= new Map(cs.cells);
      cells.set(id, { pkVal, col: change.column, newVal: value });
      continue;
    }
    // The value from before the first change is what the save requires the database still to hold.
    const original = current ? current.original : change.row[change.column];
    if (sameValue(value, original)) {
      if (!current) continue;
      cells ??= new Map(cs.cells);
      cells.delete(id);
      continue;
    }
    if (current && sameValue(current.newVal, value)) continue;
    cells ??= new Map(cs.cells);
    cells.set(id, { pkVal, col: change.column, newVal: value, key: rowKeyOf(change.row, keyCols), original });
  }
  return cells ? { ...cs, cells } : cs;
}

/** A new row: its id, and — for a cloned one — the values its cells start with. */
export interface NewRow {
  id: string;
  values?: Readonly<Record<string, unknown>>;
}

/** New rows under the rest. */
export function addRows(cs: GridChangeset, rows: readonly NewRow[]): GridChangeset {
  if (rows.length === 0) return cs;
  const cells = new Map(cs.cells);
  for (const row of rows) {
    for (const [col, value] of Object.entries(row.values ?? {})) cells.set(cellId(row.id, col), { pkVal: row.id, col, newVal: value });
  }
  return { ...cs, cells, inserted: [...cs.inserted, ...rows.map((r) => r.id)] };
}

/** A column as cloning sees it. */
export interface CloneColumn {
  name: string;
  /** Left for the database to fill in: an auto-increment key. */
  skip: boolean;
}

/**
 * What a clone of `row` starts with: every value it shows, changes included, bar the columns the
 * database fills in. Bytes only partly read cannot be written back, so they are left out too.
 */
export function cloneValues(cs: GridChangeset, row: Readonly<Record<string, unknown>>, pkCol: string, columns: readonly CloneColumn[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  // A new row holds nothing but what was put in it: its key field is only the grid's name for it.
  const fresh = isNewRowId(String(row[pkCol]));
  for (const col of columns) {
    if (col.skip) continue;
    const pending = cs.cells.get(cellId(row[pkCol], col.name));
    const value = pending ? pending.newVal : fresh ? undefined : row[col.name];
    if (value === undefined) continue;
    if (isBinaryValue(value) && value.truncated) continue;
    values[col.name] = value;
  }
  return values;
}

/**
 * Mark rows for deletion: a new row simply goes, a saved one waits for Save with its key. Either
 * way its changed cells go with it, as in DBGate: a row to be deleted shows what the database holds.
 */
export function deleteRows(cs: GridChangeset, rows: readonly Readonly<Record<string, unknown>>[], pkCol: string, keyCols: readonly string[]): GridChangeset {
  const gone = new Set<string>();
  let deleted: Map<string, RowKey> | null = null;
  for (const row of rows) {
    const rowId = String(row[pkCol]);
    if (isNewRowId(rowId)) {
      if (cs.inserted.includes(rowId)) gone.add(rowId);
    } else if (!cs.deleted.has(rowId)) {
      deleted ??= new Map(cs.deleted);
      deleted.set(rowId, rowKeyOf(row, keyCols));
      gone.add(rowId);
    }
  }
  if (!gone.size) return cs;
  return {
    cells: new Map([...cs.cells].filter(([, e]) => !gone.has(String(e.pkVal)))),
    inserted: cs.inserted.filter((id) => !gone.has(id)),
    deleted: deleted ?? cs.deleted,
  };
}

/** Rows back to how they were read: their cells unchanged and no longer deleted; new ones go. */
export function revertRows(cs: GridChangeset, rowIds: ReadonlySet<string>): GridChangeset {
  const touched = [...cs.cells.values()].some((e) => rowIds.has(String(e.pkVal)))
    || cs.inserted.some((id) => rowIds.has(id))
    || [...rowIds].some((id) => cs.deleted.has(id));
  if (!touched) return cs;
  return {
    cells: new Map([...cs.cells].filter(([, e]) => !rowIds.has(String(e.pkVal)))),
    inserted: cs.inserted.filter((id) => !rowIds.has(id)),
    deleted: new Map([...cs.deleted].filter(([id]) => !rowIds.has(id))),
  };
}

/** What a column is to the rules of what can be changed. */
export interface LockColumn {
  pk: boolean;
  autoIncrement: boolean;
}

/**
 * A cell that cannot be changed: any of a row to be deleted, a saved row's key — it is what finds
 * the row — and a new row's auto-increment key, which the database fills in.
 */
export function isCellLocked(column: LockColumn, rowId: string, cs: GridChangeset): boolean {
  if (cs.deleted.has(rowId)) return true;
  if (isNewRowId(rowId)) return column.pk && column.autoIncrement;
  return column.pk;
}

export function isEmptyChangeset(cs: GridChangeset): boolean {
  return cs.cells.size === 0 && cs.inserted.length === 0 && cs.deleted.size === 0;
}

/**
 * Rows Save would write, as its button counts them: changed rows, rows to delete, and new rows
 * something was put in.
 */
export function changedRowCount(cs: GridChangeset): number {
  const inserted = new Set(cs.inserted);
  const rows = new Set(cs.deleted.keys());
  for (const e of cs.cells.values()) {
    const rowId = String(e.pkVal);
    if (!isNewRowId(rowId) || inserted.has(rowId)) rows.add(rowId);
  }
  return rows.size;
}

/**
 * What Save sends: DBGate's INSERTs, UPDATEs and DELETEs. As in DBGate, a new row nothing was put
 * in is no INSERT: it is only dropped once the rest is saved.
 */
export function toGridChanges(cs: GridChangeset): GridChanges {
  const values = new Map<string, Record<string, unknown>>();
  const updates = new Map<string, ChangesetUpdate>();
  for (const e of cs.cells.values()) {
    const rowId = String(e.pkVal);
    if (isNewRowId(rowId)) {
      values.set(rowId, { ...values.get(rowId), [e.col]: e.newVal });
      continue;
    }
    if (!e.key) continue;
    const update = updates.get(rowId) ?? { key: e.key, set: {}, original: {} };
    update.set[e.col] = e.newVal;
    update.original![e.col] = e.original;
    updates.set(rowId, update);
  }
  const inserts = cs.inserted.map((id) => values.get(id)).filter((row): row is Record<string, unknown> => row !== undefined);
  return { inserts, updates: [...updates.values()], deletes: [...cs.deleted.values()].map((key) => ({ key })) };
}

// ── Undo and redo: each change a step, as DBGate's change set keeps them ──

export interface ChangesetHistory {
  readonly present: GridChangeset;
  readonly past: readonly GridChangeset[];
  readonly future: readonly GridChangeset[];
}

/** Steps kept to undo; the oldest go first. */
export const HISTORY_LIMIT = 200;

export const EMPTY_HISTORY: ChangesetHistory = { present: EMPTY_CHANGESET, past: [], future: [] };

/** One more step; nothing is recorded for a change that changed nothing. */
export function recordChange(h: ChangesetHistory, next: GridChangeset): ChangesetHistory {
  if (next === h.present) return h;
  const past = [...h.past, h.present];
  return { present: next, past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past, future: [] };
}

export function undoChange(h: ChangesetHistory): ChangesetHistory {
  const previous = h.past[h.past.length - 1];
  if (!previous) return h;
  return { present: previous, past: h.past.slice(0, -1), future: [h.present, ...h.future] };
}

export function redoChange(h: ChangesetHistory): ChangesetHistory {
  const next = h.future[0];
  if (!next) return h;
  return { present: next, past: [...h.past, h.present], future: h.future.slice(1) };
}
