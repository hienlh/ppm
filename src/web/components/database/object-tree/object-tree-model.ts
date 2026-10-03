/**
 * The Tables, views, functions section as a flat list of rows: a group row per kind of object,
 * its objects under it while it is open, and a table's or view's columns under it while that is
 * expanded. Searching opens every group with a match, and a table matched by a column name shows
 * its columns without being expanded by hand, as DBGate does.
 *
 * A group lists its first {@link GROUP_PAGE} objects, then a "Show N more" row, so a database of
 * ten thousand tables renders what can be seen rather than all of it.
 *
 * Pure, like `explorer-model`: the section renders what this returns and the keyboard walks it.
 */
import type { DbColumnRef, DbObject, DbObjectKind, DbObjectList, DbTableStructure } from "../../../../shared/db-structure";
import type { Loaded } from "../explorer/db-explorer-store";
import {
  KINDS_WITH_COLUMNS, groupObjects, matchingColumns, objectNodeKey, tableKeyOf,
  type DbRef, type ObjectFilter,
} from "../explorer/explorer-model";

/** How many objects a group lists before its "Show N more" row, and how many more each press adds. */
export const GROUP_PAGE = 200;
export const GROUP_PAGE_MORE = 500;

export interface ColumnRow {
  name: string;
  type: string;
  pk: boolean;
  /** `table.column` the key points at; a column in two keys names the first. */
  fk: string | null;
}

export type ObjectTreeRow =
  | { kind: "group"; key: string; group: DbObjectKind; label: string; count: number; open: boolean }
  | {
    kind: "object"; key: string; object: DbObject; nodeKey: string;
    /** A table or view, whose columns can be shown under it. */
    expandable: boolean; expanded: boolean;
    /** Its arguments are shown beside the name: another object of the group has the same name. */
    showArgs: boolean;
  }
  | { kind: "column"; key: string; column: ColumnRow; objectKey: string }
  | { kind: "columns-loading"; key: string; objectKey: string }
  | { kind: "columns-error"; key: string; objectKey: string; message: string }
  | { kind: "more"; key: string; group: DbObjectKind; hidden: number };

export interface ObjectTreeInput {
  ref: DbRef;
  list: DbObjectList;
  /** The schema picked; null takes every object (engines without a schema choice). */
  schema: string | null;
  filter: ObjectFilter;
  openGroups: readonly DbObjectKind[];
  /** Tables and views expanded by hand, by `objectNodeKey`. */
  expandedObjects: ReadonlySet<string>;
  structures: Readonly<Record<string, Loaded<DbTableStructure>>>;
  /** Objects listed per group past the first page, once "Show more" was pressed. */
  shown: Readonly<Partial<Record<DbObjectKind, number>>>;
}

export const groupRowKey = (kind: DbObjectKind) => `group:${kind}`;

/** One row per object, overloads and a table's same-named trigger included. */
export function objectRowKey(o: DbObject): string {
  return `obj:${o.kind}:${tableKeyOf(o.schema, o.name)}:${o.args ?? ""}:${o.table ?? ""}`;
}

/** A structure's columns in table order, each with whether it is in the primary key and where a key of it points. */
export function structureColumns(s: DbTableStructure): ColumnRow[] {
  const pk = new Set(s.primaryKey?.columns ?? []);
  const fk = new Map<string, string>();
  for (const key of s.foreignKeys) {
    key.columns.forEach((col, i) => { if (!fk.has(col)) fk.set(col, `${key.refTable}.${key.refColumns[i] ?? ""}`); });
  }
  return s.columns.map((c) => ({ name: c.name, type: c.type, pk: pk.has(c.name), fk: fk.get(c.name) ?? null }));
}

function fromRef(c: DbColumnRef): ColumnRow {
  return { name: c.name, type: c.type, pk: false, fk: null };
}

export function objectTreeRows(input: ObjectTreeInput): ObjectTreeRow[] {
  const { ref, list, schema, filter, expandedObjects, structures } = input;
  const searching = filter.query.trim() !== "";
  const rows: ObjectTreeRow[] = [];

  for (const { kind, label, items } of groupObjects(list, schema, filter)) {
    const open = searching || input.openGroups.includes(kind);
    rows.push({ kind: "group", key: groupRowKey(kind), group: kind, label, count: items.length, open });
    if (!open) continue;

    const limit = input.shown[kind] ?? GROUP_PAGE;
    const names = new Map<string, number>();
    for (const o of items) names.set(o.name, (names.get(o.name) ?? 0) + 1);

    for (const o of items.slice(0, limit)) {
      const key = objectRowKey(o);
      const expandable = KINDS_WITH_COLUMNS.has(o.kind);
      const nodeKey = objectNodeKey(ref, o);
      const byHand = expandable && expandedObjects.has(nodeKey);
      const matched = expandable && !byHand ? matchingColumns(o, filter) : [];
      const expanded = byHand || matched.length > 0;
      rows.push({ kind: "object", key, object: o, nodeKey, expandable, expanded, showArgs: !!o.args && (names.get(o.name) ?? 0) > 1 });
      if (!expanded) continue;

      const read = structures[nodeKey];
      if (read?.state === "ready") {
        for (const c of structureColumns(read.data)) rows.push({ kind: "column", key: `${key}|${c.name}`, column: c, objectKey: key });
      } else if (!byHand) {
        // Opened by the search: the columns read for it are enough to show, keys or not.
        for (const c of filter.columns?.get(tableKeyOf(o.schema, o.name)) ?? []) {
          rows.push({ kind: "column", key: `${key}|${c.name}`, column: fromRef(c), objectKey: key });
        }
      } else if (read?.state === "error") {
        rows.push({ kind: "columns-error", key: `${key}|error`, objectKey: key, message: read.message });
      } else {
        rows.push({ kind: "columns-loading", key: `${key}|loading`, objectKey: key });
      }
    }
    if (items.length > limit) rows.push({ kind: "more", key: `more:${kind}`, group: kind, hidden: items.length - limit });
  }
  return rows;
}

/** Tables and views expanded by hand whose structure is not read yet, for the section to ask for. */
export function structuresToRead(rows: readonly ObjectTreeRow[], structures: Readonly<Record<string, Loaded<DbTableStructure>>>): { nodeKey: string; object: DbObject }[] {
  const out: { nodeKey: string; object: DbObject }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.kind !== "object" || !row.expanded || structures[row.nodeKey]) continue;
    if (rows[i + 1]?.kind === "columns-loading") out.push({ nodeKey: row.nodeKey, object: row.object });
  }
  return out;
}
