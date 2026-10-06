/**
 * What changed between the table the catalog described (`base`) and the one the editor made of
 * it (`current`), item by item, pairing items by their id — so a column whose name alone changed
 * is a rename, never a drop and an add.
 *
 * A key, index or foreign key that changed in any way is dropped and created again, as DBGate
 * does; which of those an engine can do in place, and which make SQLite rebuild the table, is the
 * DDL generators' business.
 */
import type {
  TableModel, TableModelColumn, TableModelForeignKey, TableModelIndex, TableModelPrimaryKey, TableModelUnique,
} from "../../../shared/db-table-model.ts";
import { isSelfReference } from "../../../shared/db-table-model.ts";

export interface ColumnPair {
  before: TableModelColumn;
  after: TableModelColumn;
}

export interface TableDiff {
  addedColumns: TableModelColumn[];
  droppedColumns: TableModelColumn[];
  /** Same column, new name. */
  renamedColumns: ColumnPair[];
  /** Same column, anything but its name different; a column can be both renamed and altered. */
  alteredColumns: ColumnPair[];
  droppedPrimaryKey: TableModelPrimaryKey | null;
  addedPrimaryKey: TableModelPrimaryKey | null;
  droppedIndexes: TableModelIndex[];
  addedIndexes: TableModelIndex[];
  droppedUniques: TableModelUnique[];
  addedUniques: TableModelUnique[];
  droppedForeignKeys: TableModelForeignKey[];
  addedForeignKeys: TableModelForeignKey[];
  commentChanged: boolean;
  engineChanged: boolean;
}

/** `integer` and `INTEGER` are one type; what else counts as one is the engine's to say. */
export function sameType(a: string, b: string): boolean {
  const norm = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

/** An empty field in a dialog means "none", as a missing value does. */
function text(value: string | null | undefined): string | null {
  const t = value?.trim() ?? "";
  return t === "" ? null : t;
}

/** Everything about a column the editor can change, less its name. */
export function columnChanged(a: TableModelColumn, b: TableModelColumn): boolean {
  return !sameType(a.type, b.type)
    || a.notNull !== b.notNull
    || a.autoIncrement !== b.autoIncrement
    || text(a.defaultValue) !== text(b.defaultValue)
    || text(a.computedExpression) !== text(b.computedExpression)
    || text(a.comment) !== text(b.comment)
    || a.unsigned !== b.unsigned
    || a.zerofill !== b.zerofill;
}

const sameList = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function samePrimaryKey(a: TableModelPrimaryKey, b: TableModelPrimaryKey): boolean {
  return text(a.name) === text(b.name) && sameList(a.columns, b.columns);
}

function sameIndex(a: TableModelIndex, b: TableModelIndex): boolean {
  const part = (k: TableModelIndex["columns"][number]) =>
    JSON.stringify([k.columnId ?? null, k.expression ?? null, !!k.descending, k.nulls ?? null, k.length ?? null, k.opclass ?? null]);
  return text(a.name) === text(b.name)
    && a.unique === b.unique
    && (a.method ?? null) === (b.method ?? null)
    && text(a.where) === text(b.where)
    && sameList(a.columns.map(part), b.columns.map(part));
}

function sameUnique(a: TableModelUnique, b: TableModelUnique): boolean {
  return text(a.name) === text(b.name) && sameList(a.columns, b.columns);
}

/**
 * A foreign key's referenced columns, comparable across a rename: for a key on its own table they
 * are this table's columns, named as the model names them, so they are compared by id.
 */
function refColumnsOf(model: TableModel, fk: TableModelForeignKey): string[] {
  if (!isSelfReference(model, fk)) return fk.refColumns;
  return fk.refColumns.map((name) => model.columns.find((c) => c.name === name)?.id ?? `?${name}`);
}

function sameForeignKey(base: TableModel, a: TableModelForeignKey, current: TableModel, b: TableModelForeignKey): boolean {
  // "(not selected)" is what the engine does anyway.
  const action = (x: string | null) => x ?? "NO ACTION";
  return text(a.name) === text(b.name)
    && sameList(a.columns, b.columns)
    && (a.refSchema ?? null) === (b.refSchema ?? null)
    && a.refTable === b.refTable
    && sameList(refColumnsOf(base, a), refColumnsOf(current, b))
    && action(a.onUpdate) === action(b.onUpdate)
    && action(a.onDelete) === action(b.onDelete);
}

/** Items only in `current` are added, only in `base` dropped, and in both but different, both. */
function diffItems<T extends { id: string }>(base: readonly T[], current: readonly T[], same: (a: T, b: T) => boolean): { dropped: T[]; added: T[] } {
  const inCurrent = new Map(current.map((x) => [x.id, x]));
  const inBase = new Map(base.map((x) => [x.id, x]));
  const dropped = base.filter((x) => { const now = inCurrent.get(x.id); return !now || !same(x, now); });
  const added = current.filter((x) => { const was = inBase.get(x.id); return !was || !same(was, x); });
  return { dropped, added };
}

export function diffTableModels(base: TableModel, current: TableModel): TableDiff {
  const baseColumns = new Map(base.columns.map((c) => [c.id, c]));
  const currentIds = new Set(current.columns.map((c) => c.id));
  const renamedColumns: ColumnPair[] = [];
  const alteredColumns: ColumnPair[] = [];
  for (const after of current.columns) {
    const before = baseColumns.get(after.id);
    if (!before) continue;
    if (before.name !== after.name) renamedColumns.push({ before, after });
    if (columnChanged(before, after)) alteredColumns.push({ before, after });
  }
  const pkChanged = !(base.primaryKey && current.primaryKey && samePrimaryKey(base.primaryKey, current.primaryKey))
    && !(base.primaryKey === null && current.primaryKey === null);
  const indexes = diffItems(base.indexes, current.indexes, sameIndex);
  const uniques = diffItems(base.uniques, current.uniques, sameUnique);
  const foreignKeys = diffItems(base.foreignKeys, current.foreignKeys, (a, b) => sameForeignKey(base, a, current, b));
  return {
    addedColumns: current.columns.filter((c) => !baseColumns.has(c.id)),
    droppedColumns: base.columns.filter((c) => !currentIds.has(c.id)),
    renamedColumns,
    alteredColumns,
    droppedPrimaryKey: pkChanged ? base.primaryKey : null,
    addedPrimaryKey: pkChanged ? current.primaryKey : null,
    droppedIndexes: indexes.dropped,
    addedIndexes: indexes.added,
    droppedUniques: uniques.dropped,
    addedUniques: uniques.added,
    droppedForeignKeys: foreignKeys.dropped,
    addedForeignKeys: foreignKeys.added,
    commentChanged: text(base.comment) !== text(current.comment),
    engineChanged: text(base.engine) !== text(current.engine),
  };
}

export function isEmptyDiff(d: TableDiff): boolean {
  return d.addedColumns.length === 0 && d.droppedColumns.length === 0 && d.renamedColumns.length === 0 && d.alteredColumns.length === 0
    && !d.droppedPrimaryKey && !d.addedPrimaryKey && d.droppedIndexes.length === 0 && d.addedIndexes.length === 0
    && d.droppedUniques.length === 0 && d.addedUniques.length === 0 && d.droppedForeignKeys.length === 0 && d.addedForeignKeys.length === 0
    && !d.commentChanged && !d.engineChanged;
}

export interface RenameStep {
  from: string;
  to: string;
}

/**
 * Renames in an order that never reuses a name still taken: swapping `a` and `b` goes through a
 * name of its own, since `a → b` first would collide with the `b` not yet renamed away. `taken`
 * holds names no step may borrow (the columns that stay as they are); `caseless` is for engines
 * where `B` is taken while `b` exists (SQLite, MySQL).
 */
export function orderRenames(renames: readonly RenameStep[], taken: Iterable<string> = [], caseless = false): RenameStep[] {
  const key = (name: string) => (caseless ? name.toLowerCase() : name);
  const steps: RenameStep[] = [];
  const pending = renames.filter((r) => r.from !== r.to).map((r) => ({ ...r }));
  const used = new Set<string>([...taken, ...pending.map((r) => r.from), ...pending.map((r) => r.to)].map(key));
  let tmp = 0;
  while (pending.length > 0) {
    // One whose target nobody still holds can go now.
    const free = pending.findIndex((r) => !pending.some((o) => o !== r && key(o.from) === key(r.to)));
    if (free !== -1) {
      steps.push(pending.splice(free, 1)[0]!);
      continue;
    }
    // Only cycles are left: park one under a name no one has, and let the rest follow.
    const first = pending[0]!;
    let parked: string;
    do parked = `__ppm_rename_${++tmp}`; while (used.has(key(parked)));
    used.add(key(parked));
    steps.push({ from: first.from, to: parked });
    first.from = parked;
  }
  return steps;
}
