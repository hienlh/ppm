/**
 * One column's filter box, as the filter row and the Filters panel both draw it: the same text,
 * the same reading, the same ⋮ / ⋯ and funnel. Two boxes for one filter cannot disagree, because
 * both are this.
 */
import type { ColumnKind } from "../../../../shared/db-column-kind";
import { filterSyntax } from "../../../../shared/db-filter-parser";
import type { GridFiltering } from "../glide-grid-types";
import type { FilterCellProps } from "./filter-row";
import { columnFilterState, withColumnFilter } from "./grid-filters";
import { canChooseValues } from "./value-filter-text";

export function columnFilterCellProps(
  filtering: GridFiltering, column: string, kind: ColumnKind, fkTable: string | undefined,
): FilterCellProps {
  const filter = filtering.filters.columns[column];
  return {
    value: filter?.text ?? "",
    off: filter?.off,
    read: (text) => columnFilterState({ text }, kind),
    onCommit: (text) => filtering.onChange((f) => withColumnFilter(f, column, text)),
    serverError: filtering.errors?.[column],
    label: `Filter ${column}`,
    chooseValues: filtering.onChooseValues && canChooseValues(kind)
      ? { column, onOpen: (returnFocus) => filtering.onChooseValues!(column, returnFocus) }
      : undefined,
    lookup: fkTable && filtering.onLookup ? { table: fkTable, onOpen: (returnFocus) => filtering.onLookup!(column, returnFocus) } : undefined,
    funnel: filtering.onDialog && {
      kind: filterSyntax(kind),
      label: `Filter options: ${column}`,
      onDialog: (request, returnFocus) => filtering.onDialog!(column, request, returnFocus),
    },
  };
}
