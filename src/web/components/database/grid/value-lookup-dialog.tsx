/**
 * DBGate's ⋮ in an empty filter box: Choose value from <column>. The column's values under every
 * other filter in force — up to 100 of them, searched on the server — and the ones ticked go into
 * the box on OK as `="a",="b"`. A tick survives a search, so values can be gathered from several.
 */
import { useState } from "react";
import type { ColumnKind } from "../../../../shared/db-column-kind";
import { GRID_VALUES_LIMIT, type GridValuesResponse } from "../../../../shared/db-grid";
import { FilterDialogFrame } from "./filter-dialog-frame";
import { PickSearch, PickTable, PickValue, type PickRow } from "./pick-table";
import { usePickSearch } from "./use-pick-search";
import { pickedValuesFilter, valueKey, valueText } from "./value-filter-text";

export function ValueLookupDialog({ column, kind, load, onSubmit, onClose, returnFocus }: {
  column: string;
  /** How the column reads the text the values are written as. */
  kind: ColumnKind;
  /** The column's values containing the search, under the other filters. */
  load: (search: string) => Promise<GridValuesResponse>;
  onSubmit: (text: string) => void;
  onClose: () => void;
  returnFocus?: () => void;
}) {
  const list = usePickSearch(load);
  // In the order they were ticked, which is the order they are written in.
  const [picked, setPicked] = useState<ReadonlyMap<string, unknown>>(new Map());

  const values = list.result?.values ?? [];
  const byKey = new Map(values.map((v) => [valueKey(v), v]));
  const rows: PickRow[] = values.map((v) => {
    const text = v === null ? "NULL" : valueText(v);
    return { key: valueKey(v), label: text, cells: [<PickValue key="v" text={text} isNull={v === null} />] };
  });

  const toggle = (key: string) => setPicked((current) => {
    const next = new Map(current);
    if (next.has(key)) next.delete(key);
    else next.set(key, byKey.get(key));
    return next;
  });

  const ok = () => {
    const text = pickedValuesFilter(kind, [...picked.values()]);
    onClose();
    if (text) onSubmit(text);
  };

  return (
    <FilterDialogFrame
      title={`Choose value from ${column}`}
      description="Tick the values to filter by. OK writes them into the filter box."
      onOk={ok}
      onClose={onClose}
      returnFocus={returnFocus}
    >
      <PickSearch value={list.search} onChange={list.setSearch} onSearchNow={list.searchNow} label="Search values" />
      <PickTable headers={[{ label: "Value" }]} rows={rows} picked={new Set(picked.keys())} onToggle={toggle}>
        <PickListNote
          loading={list.loading && !list.result}
          error={list.error}
          empty={!!list.result && values.length === 0}
          query={list.resultFor}
          more={list.result?.hasMore ? `Showing the first ${GRID_VALUES_LIMIT} values. Search to find the others.` : null}
          none="No values to choose from."
        />
      </PickTable>
    </FilterDialogFrame>
  );
}

/**
 * What a pick list says under its rows: that it is loading, why it failed, why it is empty, or that
 * it is cut short. A search asked again after a failure is loading, not still failing.
 */
export function PickListNote({ loading, error, empty, query, more, none }: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  /** The search the list is for. */
  query: string;
  more: string | null;
  /** Said when there is nothing to list and nothing was searched for. */
  none: string;
}) {
  const note = "px-2.5 py-3 text-xs text-text-3 max-md:text-sm";
  if (loading) return <p className={note}>Loading…</p>;
  if (error) return <p role="alert" className={`${note} text-error`}>{error}</p>;
  if (empty) return <p className={note}>{query.trim() ? `Nothing matches “${query.trim()}”.` : none}</p>;
  if (more) return <p className={`${note} border-t border-border-soft`}>{more}</p>;
  return null;
}
