/**
 * A phone's "Columns and filters": the panel a desktop keeps beside the grid, as one bottom sheet.
 * Columns is the panel's list at 44px. Filters is where a phone switches a filter on or off,
 * removes it, and starts a Multi column filter — each row opens that filter's own sheet, since a
 * phone types a filter there and nowhere else. References, last, shows the one picked under the grid.
 */
import { useId, useState } from "react";
import { AlertTriangle, Filter, Key, Link, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import type { GridColumnSchema, GridFiltering } from "../glide-grid-types";
import { SectionHeader } from "../explorer/tree-parts";
import { ColumnsSection } from "./columns-panel";
import type { GridReference, TableReferences } from "./references";
import { ReferencesSection } from "./references-panel";
import {
  columnFilterState, multiFilterState, withColumnFilter, withFilterOff, withMultiFilter, type FilterState, type FilterText,
} from "./grid-filters";

/** "users · 7 of 9 columns shown" */
export function columnsShownLabel(table: string, total: number, hidden: number): string {
  return `${table} · ${total - hidden} of ${total} columns shown`;
}

export function ColumnsSheet({ table, schema, hidden, onHiddenChange, onJump, onOpenTable, filtering, onOpenFilter, references, focusSearch, onClose }: {
  table: string;
  schema: readonly GridColumnSchema[];
  hidden: ReadonlySet<string>;
  onHiddenChange: (hidden: Set<string>) => void;
  onJump: (column: string) => void;
  onOpenTable?: (table: string) => void;
  /** Absent where the rows cannot be filtered. */
  filtering?: GridFiltering;
  /** A filter's own sheet: a column's, or the Multi column filter's (`null`). */
  onOpenFilter: (column: string | null) => void;
  /** DBGate's References; absent for a table with none. */
  references?: { refs: TableReferences; open: GridReference | null; onOpen: (reference: GridReference) => void };
  /** Find column: the search box takes the focus, then this is called. */
  focusSearch?: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [columnsCollapsed, setColumnsCollapsed] = useState(false);
  const [filtersCollapsed, setFiltersCollapsed] = useState(false);
  const [referencesCollapsed, setReferencesCollapsed] = useState(false);
  const hiddenHere = schema.filter((c) => hidden.has(c.name)).length;
  const handOff = (open: () => void) => {
    onClose();
    open();
  };

  return (
    <BottomSheet open onClose={onClose} className="popover-solid">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex max-h-[calc(var(--sheet-vh,100dvh)*0.85)] flex-col">
        <div className="flex shrink-0 items-center gap-2.5 pr-1.5 pb-1 pl-4">
          <h2 id={titleId} className="min-w-0 flex-1 text-[15px] font-semibold">
            <span className="block truncate">Columns and filters</span>
            <small className="block truncate text-xs font-normal text-text-3">{columnsShownLabel(table, schema.length, hiddenHere)}</small>
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-11 shrink-0 place-items-center rounded-lg text-text-2 active:bg-surface-hover">
            <X className="size-5" />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto pb-2">
          <ColumnsSection
            schema={schema} hidden={hidden} onHiddenChange={onHiddenChange}
            onJump={(column) => handOff(() => onJump(column))}
            onOpenTable={onOpenTable && ((t) => handOff(() => onOpenTable(t)))}
            sheet grow={false} collapsed={columnsCollapsed} onCollapsedChange={setColumnsCollapsed} focusSearch={focusSearch}
          />
          {filtering && (
            <section aria-label="Filters" className="border-t border-border-soft">
              <SectionHeader title="Filters" collapsed={filtersCollapsed} onToggle={() => setFiltersCollapsed((c) => !c)} />
              {!filtersCollapsed && <FilterRows filtering={filtering} schema={schema} onOpen={(column) => handOff(() => onOpenFilter(column))} />}
            </section>
          )}
          {references && (
            <div className="border-t border-border-soft">
              <ReferencesSection
                table={table} references={references.refs} open={references.open}
                onOpen={(reference) => handOff(() => references.onOpen(reference))}
                sheet grow={false} collapsed={referencesCollapsed} onCollapsedChange={setReferencesCollapsed}
              />
            </div>
          )}
        </div>

        <div className="flex shrink-0 border-t border-border-soft px-3 pt-2.5">
          <Button type="button" onClick={onClose} className="h-11 flex-1 text-sm">Done</Button>
        </div>
      </div>
    </BottomSheet>
  );
}

interface Row {
  /** Null for the Multi column filter. */
  column: string | null;
  filter?: FilterText;
  state: FilterState["state"];
}

const TEXT_STATE: Record<FilterState["state"], string> = {
  empty: "text-text-3",
  ok: "text-success",
  off: "text-text-3 line-through",
  bad: "text-error",
};

/** The Multi column filter first — there to be started when there is none — then each column's. */
function FilterRows({ filtering, schema, onOpen }: {
  filtering: GridFiltering;
  schema: readonly GridColumnSchema[];
  onOpen: (column: string | null) => void;
}) {
  const { filters, columns, onChange, errors } = filtering;
  const byName = new Map(schema.map((c) => [c.name, c]));
  const rows: Row[] = [
    { column: null, filter: filters.multi, state: multiFilterState(filters.multi, columns).state },
    ...columns.flatMap((c): Row[] => {
      const filter = filters.columns[c.name];
      if (!filter) return [];
      const { state } = columnFilterState(filter, c.kind);
      return [{ column: c.name, filter, state: state === "ok" && errors?.[c.name] ? "bad" : state }];
    }),
  ];

  return (
    <div className="pb-1">
      {rows.map((row) => {
        const col = row.column === null ? undefined : byName.get(row.column);
        const Icon = row.state === "bad" ? AlertTriangle : row.column === null ? Filter : col?.pk ? Key : col?.fk ? Link : Filter;
        const name = row.column ?? "Multi column filter";
        const text = row.filter?.text.trim() ? row.filter.text : null;
        const what = row.column === null ? "the Multi column filter" : `the ${row.column} filter`;
        return (
          <div key={row.column ?? "\0multi"} className="mx-1.5 flex min-h-11 items-center rounded-lg select-none">
            <button
              type="button" onClick={() => onOpen(row.column)}
              aria-label={text ? `${name}: ${text}` : `${name}: none — tap to add one`}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm active:bg-surface-hover"
            >
              <Icon className={cn("size-[18px] shrink-0", row.state === "bad" ? "text-error" : col?.pk ? "text-warning" : col?.fk ? "text-info" : "text-text-3")} aria-hidden />
              <span className={cn("shrink-0", row.column === null && !text ? "text-text-3" : "font-semibold")}>{name}</span>
              <span className={cn("min-w-0 truncate font-mono text-xs", TEXT_STATE[row.state])}>{text ?? "Tap to add"}</span>
            </button>
            {row.filter && text && (
              <>
                <label className="grid size-11 shrink-0 cursor-pointer place-items-center" title={row.filter.off ? "Enable this filter" : "Disable this filter"}>
                  <input
                    type="checkbox" checked={!row.filter.off}
                    onChange={(e) => onChange((f) => withFilterOff(f, row.column, !e.target.checked))}
                    aria-label={`Apply ${what}`} className="size-5 cursor-pointer accent-primary"
                  />
                </label>
                <button
                  type="button" aria-label={`Remove ${what}`} title="Remove"
                  onClick={() => onChange((f) => (row.column === null ? withMultiFilter(f, "") : withColumnFilter(f, row.column, "")))}
                  className="grid size-11 shrink-0 place-items-center rounded-lg text-text-3 active:bg-surface-hover"
                >
                  <X className="size-4" />
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
