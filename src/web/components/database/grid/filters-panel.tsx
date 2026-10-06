/**
 * DBGate's Filters panel beside the grid. The Multi column filter comes first — one text that
 * every column of the table reads, hidden ones too — and under it every column filter there is,
 * each with a checkbox that keeps it without applying it and × that removes it. A column's box
 * here is the filter row's box for that column, so typing in either is typing in both. The form
 * view puts its Column name filter on top, and Add to filter gives a column an empty box here,
 * which stays until its × takes it away.
 */
import { useState, type ReactNode } from "react";
import { Key, Link, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { GridColumnSchema, GridFiltering } from "../glide-grid-types";
import { SectionHeader } from "../explorer/tree-parts";
import { columnFilterCellProps } from "./column-filter-cell";
import { FilterCell } from "./filter-row";
import { multiFilterState, withColumnFilter, withFilterOff, withMultiFilter, type FilterText } from "./grid-filters";

export function FiltersPanel({ filtering, schema, nameFilter, added, onRemoveAdded }: {
  filtering: GridFiltering;
  schema: readonly GridColumnSchema[];
  /** The form view's Column name filter: the fields whose names it matches are marked in the form. */
  nameFilter?: { text: string; onChange: (text: string) => void };
  /** Columns Add to filter gave a box, kept until removed whether or not anything is typed in them. */
  added?: readonly string[];
  onRemoveAdded?: (column: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { filters, columns, onChange } = filtering;
  const byName = new Map(schema.map((c) => [c.name, c]));
  const kept = new Set(added);
  const multi = filters.multi;
  return (
    <section aria-label="Filters" className="flex min-h-0 flex-col">
      <SectionHeader title="Filters" collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      {!collapsed && (
        <div className="grid min-h-0 content-start gap-2 overflow-auto px-2 pb-2.5">
          {nameFilter && <ColumnNameFilter {...nameFilter} />}
          <FilterBlock
            title={<span className="min-w-0 truncate text-[11.5px] text-text-3">Multi column filter</span>}
            filter={multi} name="this filter"
            onSwitch={(on) => onChange((f) => withFilterOff(f, null, !on))}
            onRemove={() => onChange((f) => withMultiFilter(f, ""))}
          >
            <FilterCell
              size="panel"
              value={multi?.text ?? ""} off={multi?.off}
              read={(text) => multiFilterState({ text }, columns)}
              onCommit={(text) => onChange((f) => withMultiFilter(f, text))}
              label="Multi column filter"
              funnel={filtering.onDialog && {
                kind: "multi",
                label: "Filter options: all columns",
                onDialog: (request, returnFocus) => filtering.onDialog!(null, request, returnFocus),
              }}
            />
          </FilterBlock>
          {columns.filter((c) => filters.columns[c.name] || kept.has(c.name)).map((c) => {
            const col = byName.get(c.name);
            const Icon = col?.pk ? Key : col?.fk ? Link : null;
            const remove = () => {
              onChange((f) => withColumnFilter(f, c.name, ""));
              if (kept.has(c.name)) onRemoveAdded?.(c.name);
            };
            return (
              <FilterBlock
                key={c.name}
                title={(
                  <>
                    {Icon && <Icon className={cn("size-3.5 shrink-0", col?.pk ? "text-warning" : "text-info")} aria-hidden />}
                    {/* Bold is NOT NULL, as in the column list. */}
                    <span className={cn("min-w-0 truncate text-[11.5px]", col && !col.nullable ? "font-semibold text-text" : "text-text-3")}>{c.name}</span>
                  </>
                )}
                filter={filters.columns[c.name]} name={`the ${c.name} filter`}
                onSwitch={(on) => onChange((f) => withFilterOff(f, c.name, !on))}
                onRemove={remove} removable={kept.has(c.name)}
              >
                <FilterCell {...columnFilterCellProps(filtering, c.name, c.kind, col?.fk?.table)} size="panel" />
              </FilterBlock>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * One filter in the panel: what it is on, its switch and its ×, then its box. A filter not there
 * yet has neither — bar the × of a box Add to filter put there, which takes the box away.
 */
function FilterBlock({ title, filter, name, onSwitch, onRemove, removable, children }: {
  title: ReactNode;
  filter: FilterText | undefined;
  /** What the switch and × act on, as a screen reader hears it: "Apply the <name>". */
  name: string;
  onSwitch: (on: boolean) => void;
  onRemove: () => void;
  removable?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-[3px]">
      <div className="flex h-5 min-w-0 items-center gap-[5px]">
        {title}
        {filter && (
          <label className="ml-auto grid size-5 shrink-0 cursor-pointer place-items-center" title={filter.off ? "Enable this filter" : "Disable this filter"}>
            <input
              type="checkbox" checked={!filter.off} onChange={(e) => onSwitch(e.target.checked)}
              aria-label={`Apply ${name}`} className="size-[13px] cursor-pointer accent-primary"
            />
          </label>
        )}
        {(filter || removable) && (
          <>
            <button
              type="button" onClick={onRemove} aria-label={`Remove ${name}`} title="Remove"
              className={cn("grid size-5 shrink-0 place-items-center rounded text-text-3 can-hover:hover:bg-surface-hover can-hover:hover:text-text", !filter && "ml-auto")}
            >
              <X className="size-3" />
            </button>
          </>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * DBGate's Column name filter, on top of the form view's filters: words and capitals as its
 * `filterName` reads them (`CA` is `created_at`). Escape empties it, as in DBGate.
 */
function ColumnNameFilter({ text, onChange }: { text: string; onChange: (text: string) => void }) {
  return (
    <div className="grid gap-[3px]">
      <div className="flex h-5 min-w-0 items-center gap-[5px]">
        <span className="min-w-0 truncate text-[11.5px] text-text-3">Column name filter</span>
      </div>
      <div className="flex min-w-0 items-center gap-px">
        <input
          value={text} onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || !text) return;
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }}
          aria-label="Column name filter" spellCheck={false} autoComplete="off" autoCapitalize="off"
          className="h-[26px] w-full min-w-0 rounded-[5px] border border-border-soft bg-input px-1.5 text-[11.5px] text-text outline-none placeholder:text-text-3/70 focus:border-primary"
        />
        {text && (
          <button
            type="button" onClick={() => onChange("")} aria-label="Clear the column name filter" title="Clear"
            className="grid size-5 shrink-0 place-items-center rounded text-text-3 can-hover:hover:bg-surface-hover can-hover:hover:text-text"
          >
            <X className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}
