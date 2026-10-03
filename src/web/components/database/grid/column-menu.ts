/**
 * DBGate's column menu, opened from ⌄ at the end of a column's title: the free edition's items, in
 * its order. Sort ascending / descending replace the whole sort with this column; Add to sort
 * appends it to the columns already sorted by; Clear sort criteria takes every column's sort off,
 * not only this one's. Clicking a title selects its column instead, so this is the only way to sort.
 */
import type { GridSort, SortDir } from "../../../../shared/db-grid";

export type ColumnMenuItem =
  | { kind: "sort"; label: string; sort: GridSort[]; dir?: SortDir; checked?: boolean }
  | { kind: "copy-name"; label: string }
  | { kind: "open-table"; label: string; table: string }
  | { kind: "separator" };

/** `column` alone, which way given: DBGate's Sort ascending and Sort descending. */
export const sortBy = (column: string, dir: SortDir): GridSort[] => [{ column, dir }];

/** `column` after the columns already sorted by: DBGate's Add to sort. */
export const addToSort = (sort: readonly GridSort[], column: string, dir: SortDir): GridSort[] => [
  ...sort.filter((s) => s.column !== column),
  { column, dir },
];

/** Where `column` stands in the sort: its direction and its place, from 1. */
export function sortPosition(sort: readonly GridSort[], column: string): { dir: SortDir; index: number } | null {
  const i = sort.findIndex((s) => s.column === column);
  return i < 0 ? null : { dir: sort[i]!.dir, index: i + 1 };
}

/**
 * The column menu's items for `column`. `fkTable` is the table a foreign key column refers to, which
 * the menu opens. A sort item is ticked when it is the sort in force, which only a sheet shows.
 */
export function columnMenuItems(column: string, sort: readonly GridSort[], fkTable?: string | null): ColumnMenuItem[] {
  const own = sortPosition(sort, column);
  const alone = own !== null && sort.length === 1;
  const items: ColumnMenuItem[] = [
    { kind: "sort", label: "Sort ascending", sort: sortBy(column, "ASC"), dir: "ASC", checked: alone && own.dir === "ASC" },
    { kind: "sort", label: "Sort descending", sort: sortBy(column, "DESC"), dir: "DESC", checked: alone && own.dir === "DESC" },
  ];
  if (sort.length > 0 && !own) {
    items.push(
      { kind: "sort", label: "Add to sort - ascending", sort: addToSort(sort, column, "ASC"), dir: "ASC" },
      { kind: "sort", label: "Add to sort - descending", sort: addToSort(sort, column, "DESC"), dir: "DESC" },
    );
  }
  if (own) items.push({ kind: "sort", label: "Clear sort criteria", sort: [] });
  items.push({ kind: "copy-name", label: "Copy column name" });
  if (fkTable) items.push({ kind: "separator" }, { kind: "open-table", label: fkTable, table: fkTable });
  return items;
}
