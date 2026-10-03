/**
 * DBGate's ⋯ in an empty filter box on a foreign key: Lookup from <table>. The referenced table's
 * rows, each by its key (Value) and a column that says what the row is (Description) — so a plan
 * is picked by its name rather than its number — and the keys ticked go into the box on OK as
 * `="1",="3"`. A search looks in both columns. Customize picks the Description, remembered per
 * table. The rows come from the referenced table's own `POST grid`; nothing here is new SQL.
 * The same lookup from a foreign key cell's editor (`onPick`) picks one row, whose key goes into
 * the cell.
 */
import { useEffect, useId, useState } from "react";
import { ChevronDown } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ColumnKind } from "../../../../shared/db-column-kind";
import type { FilterableColumn } from "../../../../shared/db-filter-parser";
import type { FilterGroup } from "../../../../shared/db-grid";
import { FilterDialogFrame } from "./filter-dialog-frame";
import { PickSearch, PickTable, PickValue, type PickRow } from "./pick-table";
import { usePickSearch } from "./use-pick-search";
import { LOOKUP_ROWS, descriptionColumn, lookupSearch, pickedValuesFilter, valueKey, valueText } from "./value-filter-text";
import { PickListNote } from "./value-lookup-dialog";

/** What a lookup reads: the referenced table, through the caller's requests. */
export interface LookupSource {
  /** The referenced table, as the title names it. */
  table: string;
  /** The column the foreign key references: its values are what the box is given. */
  keyColumn: string;
  /** The referenced table's columns, and how each reads a search. */
  columns: () => Promise<FilterableColumn[]>;
  /** Its first rows by key, matching the search. */
  rows: (anyColumn: FilterGroup[]) => Promise<{ rows: Record<string, unknown>[]; hasMore: boolean }>;
  /** The Description chosen for this table before, if one was. */
  description: string | null;
  /** Remembers a new choice. */
  onDescription: (column: string) => void;
}

export function DictionaryLookupDialog({ source, kind, onSubmit, onPick, onClose, returnFocus }: {
  source: LookupSource;
  /** How the foreign key column reads the text the keys are written as. */
  kind: ColumnKind;
  /** The filter text for the keys ticked. */
  onSubmit?: (text: string) => void;
  /** One row instead, its key as it was read: for a cell rather than a filter box. */
  onPick?: (value: unknown) => void;
  onClose: () => void;
  returnFocus?: () => void;
}) {
  const [columnsRead] = useState(() => source.columns());
  const [columns, setColumns] = useState<FilterableColumn[] | null>(null);
  useEffect(() => {
    let live = true;
    columnsRead.then((c) => { if (live) setColumns(c); }, () => { /* the list says why */ });
    return () => { live = false; };
  }, [columnsRead]);

  const [chosen, setChosen] = useState(source.description);
  const [customizing, setCustomizing] = useState(false);
  const customizeId = useId();
  const description = columns ? descriptionColumn(columns, source.keyColumn, chosen) : null;

  const list = usePickSearch(async (search) => {
    const all = await columnsRead;
    const shown = descriptionColumn(all, source.keyColumn, chosen);
    const groups = lookupSearch(search, all.filter((c) => c.name === source.keyColumn || c.name === shown));
    return groups === null ? { rows: [], hasMore: false } : source.rows(groups);
  }, chosen ?? "");

  // In the order they were ticked, which is the order they are written in.
  const [picked, setPicked] = useState<ReadonlyMap<string, unknown>>(new Map());
  const found = list.result?.rows ?? [];
  const keyOf = (row: Record<string, unknown>) => valueKey(row[source.keyColumn]);
  const byKey = new Map(found.map((row) => [keyOf(row), row[source.keyColumn]]));
  const rows: PickRow[] = found.map((row) => {
    const key = row[source.keyColumn];
    const keyText = key === null || key === undefined ? "NULL" : valueText(key);
    const desc = description ? row[description] : undefined;
    const descText = desc === null || desc === undefined ? "" : valueText(desc);
    return {
      key: keyOf(row),
      label: description && descText ? `${keyText} ${descText}` : keyText,
      cells: [
        <PickValue key="k" text={keyText} isNull={key === null} mono />,
        ...(description ? [<PickValue key="d" text={descText} isNull={desc === null} />] : []),
      ],
    };
  });

  const toggle = (key: string) => setPicked((current) => {
    if (onPick) return current.has(key) ? new Map() : new Map([[key, byKey.get(key)]]);
    const next = new Map(current);
    if (next.has(key)) next.delete(key);
    else next.set(key, byKey.get(key));
    return next;
  });

  const choose = (column: string) => {
    setChosen(column);
    source.onDescription(column);
  };

  const ok = () => {
    const values = [...picked.values()];
    onClose();
    if (onPick) {
      if (values.length) onPick(values[0]);
      return;
    }
    const text = pickedValuesFilter(kind, values);
    if (text) onSubmit?.(text);
  };

  return (
    <FilterDialogFrame
      title={`Lookup from ${source.table}`}
      description={onPick
        ? `Pick the ${source.table} row whose key goes into the cell. OK puts it there.`
        : `Tick the ${source.table} rows to filter by. OK writes their keys into the filter box.`}
      onOk={ok}
      onClose={onClose}
      returnFocus={returnFocus}
      extraButton={(className) => (
        <Button
          type="button" size="sm" variant="outline" className={className}
          onClick={() => setCustomizing((c) => !c)} disabled={!columns}
          aria-expanded={customizing} aria-controls={customizeId}
        >
          Customize
        </Button>
      )}
    >
      <PickSearch value={list.search} onChange={list.setSearch} onSearchNow={list.searchNow} label={`Search ${source.table}`} />
      {customizing && columns && (
        <label id={customizeId} className="flex items-center gap-2 text-[13px] text-text-2 max-md:flex-col max-md:items-stretch md:text-[12.5px]">
          <span className="shrink-0">Description</span>
          <span className="relative flex min-w-0 flex-1">
            <select
              value={description ?? ""}
              onChange={(e) => choose(e.target.value)}
              aria-label="Description column"
              className={cn(
                "h-11 w-full min-w-0 appearance-none rounded-md border border-border bg-surface pr-7 pl-2.5 text-[15px] text-text-primary outline-none focus:border-ring",
                "md:h-[30px] md:font-mono md:text-xs",
              )}
            >
              {description === null && <option value="" disabled>None</option>}
              {columns.filter((c) => c.name !== source.keyColumn).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-text-subtle" />
          </span>
        </label>
      )}
      <PickTable
        headers={description ? [{ label: "Value", width: "w-[38%]" }, { label: "Description" }] : [{ label: "Value" }]}
        rows={rows} picked={new Set(picked.keys())} onToggle={toggle}
      >
        <PickListNote
          loading={list.loading && !list.result}
          error={list.error}
          empty={!!list.result && found.length === 0}
          query={list.resultFor}
          more={list.result?.hasMore ? `Showing the first ${LOOKUP_ROWS} rows. Search to find the others.` : null}
          none={`${source.table} has no rows.`}
        />
      </PickTable>
    </FilterDialogFrame>
  );
}
