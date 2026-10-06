/**
 * The one filter dialog a table view has open at a time, wherever its funnel was: the filter row
 * or the Filters panel. Whatever it builds goes into the filter box of the column it was opened
 * for — or into the Multi column filter, which has no column.
 */
import type { ColumnKind } from "../../../../shared/db-column-kind";
import type { GridValuesResponse } from "../../../../shared/db-grid";
import { DictionaryLookupDialog, type LookupSource } from "./dictionary-lookup-dialog";
import type { FilterDialogRequest } from "./filter-funnel-menu";
import { FilterMultipleValuesDialog } from "./filter-multiple-values-dialog";
import { SetFilterDialog } from "./set-filter-dialog";
import { ValueLookupDialog } from "./value-lookup-dialog";

/** A funnel item's dialog, ⋮ (`values`) or ⋯ (`lookup`). */
export type FilterBoxDialog =
  | FilterDialogRequest
  | { dialog: "values"; column: string; kind: ColumnKind; load: (search: string) => Promise<GridValuesResponse> }
  | { dialog: "lookup"; kind: ColumnKind; source: LookupSource };

export interface OpenFilterDialog {
  /** Null for the Multi column filter. */
  column: string | null;
  request: FilterBoxDialog;
  /** Puts focus back in the box the dialog was opened from. */
  returnFocus: () => void;
}

export function FilterDialogHost({ open, onClose, onSubmit }: {
  open: OpenFilterDialog | null;
  onClose: () => void;
  onSubmit: (column: string | null, text: string) => void;
}) {
  if (!open) return null;
  const submit = (text: string) => onSubmit(open.column, text);
  const common = { onSubmit: submit, onClose, returnFocus: open.returnFocus };
  const request = open.request;
  switch (request.dialog) {
    case "condition": return <SetFilterDialog request={request} {...common} />;
    case "lines": return <FilterMultipleValuesDialog {...common} />;
    case "values": return <ValueLookupDialog column={request.column} kind={request.kind} load={request.load} {...common} />;
    case "lookup": return <DictionaryLookupDialog source={request.source} kind={request.kind} {...common} />;
  }
}
