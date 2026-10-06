/**
 * The Structure tab's changes not yet saved, kept in the tab's metadata so a reload does not lose
 * them: DBGate's `base` and `current`. `base` is the table as it was when the first change was
 * made — as the database had it, or for a table not created yet, as New table starts one — and
 * `current` is what the changes made of it. Until the first change nothing is kept, and the tab
 * shows the table as the database has it now.
 *
 * Pure: it imports no store, so it runs under `bun:test`.
 */
import { modelFromStructure, sameTableModel, type TableModel } from "../../shared/db-table-model";
import type { DbTableStructure } from "../../shared/db-structure";
import type { DialectName } from "../../shared/db-types";

export interface TableEdit {
  base: TableModel;
  current: TableModel;
  /** The table does not exist yet: Save creates it, and Reset changes goes back to `base`. */
  isNew?: true;
}

/** The metadata field the edit is kept under. */
export const TABLE_EDIT_FIELD = "tableEdit";

const isList = (v: unknown) => Array.isArray(v);

/** Enough of a model to draw: what an older or damaged tab holds instead is dropped, not drawn. */
function isModel(v: unknown): v is TableModel {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m.name === "string" && isList(m.columns) && isList(m.indexes) && isList(m.uniques) && isList(m.foreignKeys) && isList(m.checks);
}

export function readTableEdit(metadata: Record<string, unknown> | undefined): TableEdit | null {
  const e = metadata?.[TABLE_EDIT_FIELD];
  if (typeof e !== "object" || e === null) return null;
  const { base, current, isNew } = e as Record<string, unknown>;
  if (!isModel(base) || !isModel(current)) return null;
  return isNew === true ? { base, current, isNew: true } : { base, current };
}

/** The tab holds changes nothing else keeps: DBGate's unsaved dot, and closing it asks first. */
export function isStructureTabDirty(metadata: Record<string, unknown> | undefined): boolean {
  const edit = readTableEdit(metadata);
  return edit !== null && !sameTableModel(edit.base, edit.current);
}

/**
 * The edit after one more change. The first change starts from the table as the database has it
 * (`live`); a change that brings an existing table back to where it started ends the edit, so the
 * tab shows the live table again rather than a copy of it that can go stale.
 */
export function nextTableEdit(
  edit: TableEdit | null,
  live: DbTableStructure | null,
  dialect: DialectName,
  change: (model: TableModel) => TableModel,
): TableEdit | null {
  const start = edit ?? (live ? { base: modelFromStructure(live, dialect), current: modelFromStructure(live, dialect) } : null);
  if (!start) return null;
  const current = change(start.current);
  if (!start.isNew && sameTableModel(start.base, current)) return null;
  return { ...start, current };
}

/** The metadata with `edit` in it, or with the field gone for none. */
export function withTableEdit(metadata: Record<string, unknown> | undefined, edit: TableEdit | null): Record<string, unknown> {
  const { [TABLE_EDIT_FIELD]: _, ...rest } = metadata ?? {};
  return edit ? { ...rest, [TABLE_EDIT_FIELD]: edit } : rest;
}

/** Reset changes: a new table goes back to how New table started it, an existing one to the live table. */
export function resetTableEdit(edit: TableEdit | null): TableEdit | null {
  return edit?.isNew ? { ...edit, current: edit.base } : null;
}

// ─── New table ───────────────────────────────────────────────────────────────

/**
 * What a New table tab holds, besides where it is: the table as DBGate starts one, under the id
 * that keeps each such tab its own (`dbTabId`), and its number for "Table #N".
 */
export function newTableTabMetadata(model: TableModel, tableNumber: number, newTableId: string): Record<string, unknown> {
  return { newTableId, tableNumber, schemaName: model.schema ?? "", [TABLE_EDIT_FIELD]: { base: model, current: model, isNew: true } };
}

/** The next "Table #N": one past the highest a New table tab already has, as DBGate numbers them. */
export function nextTableNumber(tabs: Iterable<{ type: string; metadata?: Record<string, unknown> }>): number {
  let max = 0;
  for (const tab of tabs) {
    const n = tab.type === "db-structure" ? tab.metadata?.tableNumber : undefined;
    if (typeof n === "number" && n > max) max = n;
  }
  return max + 1;
}
