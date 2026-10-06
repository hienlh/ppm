/**
 * DBGate's References: the tables a table's own keys point at (References tables) and the tables
 * whose keys point at it (Dependent tables), and what one of them shown under the grid — master /
 * detail — is filtered by. The detail follows the rows selected in the master: each of its key
 * columns must hold a value one of those rows has in the column it pairs with, column by column,
 * as DBGate's detail filter is built.
 */
import type { ColumnKind } from "../../../../shared/db-column-kind";
import type { FilterGroup } from "../../../../shared/db-grid";
import type { DbForeignKey } from "../../../../shared/db-structure";
import { keyValuesFilter } from "./reference-filter";

export interface GridReference {
  /** "out": a key this table holds (References tables); "in": a key another table holds (Dependent tables). */
  direction: "out" | "in";
  /** The table shown under the grid; a null schema is the connection's own. */
  schema: string | null;
  table: string;
  /** Each column of the table below, with the master's column whose value it holds. */
  columns: readonly { detail: string; master: string }[];
  /** The columns the key is made of, which the list names it by: `plans (plan_id)`, `orders (user_id)`. */
  keyColumns: readonly string[];
  /** The key's own name, telling apart two keys between the same tables; null where the catalog has none. */
  name: string | null;
}

export interface TableReferences {
  out: GridReference[];
  in: GridReference[];
}

/** Pairs a key's columns with the ones it references; null when they do not pair up, so it filters nothing. */
function pairs(fk: DbForeignKey): { column: string; ref: string }[] | null {
  if (fk.columns.length === 0 || fk.columns.length !== fk.refColumns.length) return null;
  return fk.columns.map((column, i) => ({ column, ref: fk.refColumns[i]! }));
}

/** A table's references, from its structure: `foreignKeys` are the keys it holds, `references` those pointing at it. */
export function tableReferences(structure: { foreignKeys: readonly DbForeignKey[]; references: readonly DbForeignKey[] }): TableReferences {
  return {
    out: structure.foreignKeys.flatMap((fk): GridReference[] => {
      const keys = pairs(fk);
      return keys ? [{
        direction: "out", schema: fk.refSchema, table: fk.refTable, name: fk.name, keyColumns: fk.columns,
        columns: keys.map((k) => ({ detail: k.ref, master: k.column })),
      }] : [];
    }),
    in: structure.references.flatMap((fk): GridReference[] => {
      const keys = pairs(fk);
      return keys ? [{
        direction: "in", schema: fk.schema, table: fk.table, name: fk.name, keyColumns: fk.columns,
        columns: keys.map((k) => ({ detail: k.column, master: k.ref })),
      }] : [];
    }),
  };
}

export function hasReferences(refs: TableReferences | null): refs is TableReferences {
  return !!refs && refs.out.length + refs.in.length > 0;
}

/**
 * Tells references apart: a table can reference another twice, and itself both ways. By the columns
 * each one joins, not only those of its key: SQLite names no key, and one column can reference two
 * keys of a table.
 */
export function referenceId(ref: GridReference): string {
  return [ref.direction, ref.schema ?? "", ref.table, ref.name ?? "", ...ref.columns.flatMap((c) => [c.detail, c.master])].join("\u0000");
}

/** The references whose table or key columns contain the search, in their order. */
export function referencesMatching(refs: TableReferences, query: string): TableReferences {
  const needle = query.trim().toLowerCase();
  if (!needle) return refs;
  const hit = (ref: GridReference) => ref.table.toLowerCase().includes(needle) || ref.keyColumns.join(", ").toLowerCase().includes(needle);
  return { out: refs.out.filter(hit), in: refs.in.filter(hit) };
}

/** DBGate's detail header, the join read out: `orders [user_id] = master [id]`. */
export function referenceJoin(ref: GridReference): { table: string; detail: string; master: string } {
  return {
    table: ref.table,
    detail: ref.columns.map((c) => c.detail).join(", "),
    master: ref.columns.map((c) => c.master).join(", "),
  };
}

/**
 * What the detail is filtered by for the master's selected rows: one group per key column, holding
 * the values those rows have in the master column it pairs with. Null when a column has no value
 * to filter by — no row selected, a NULL key, a new row — since then no row of the detail belongs
 * to the selection.
 */
export function detailKeyFilters(
  ref: GridReference, masterRows: readonly Record<string, unknown>[], kindOf: (column: string) => ColumnKind,
): FilterGroup[] | null {
  const groups: FilterGroup[] = [];
  for (const { detail, master } of ref.columns) {
    const filter = keyValuesFilter(detail, kindOf(detail), masterRows.map((row) => row[master]));
    if (!filter) return null;
    groups.push(filter.group);
  }
  return groups;
}
