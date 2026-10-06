/**
 * DBGate's References, in the panel beside a table's grid and in a phone's Columns and filters
 * sheet: the tables this table's keys point at (References tables) and those whose keys point at
 * it (Dependent tables), each named by its key's columns. Clicking one shows it under the grid,
 * following the rows selected there (`master-detail-split.tsx`).
 */
import { useState } from "react";
import { Table } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { EmptyState, Highlight, SearchBox, SectionHeader } from "../explorer/tree-parts";
import { referenceId, referencesMatching, type GridReference, type TableReferences } from "./references";

export function ReferencesSection({ table, references, open, onOpen, sheet = false, grow = true, collapsed, onCollapsedChange }: {
  /** The table the references are of, which the list is named after. */
  table: string;
  references: TableReferences;
  /** The reference shown under the grid, lit in the list. */
  open: GridReference | null;
  onOpen: (reference: GridReference) => void;
  /** In a phone's sheet: every row 44px. */
  sheet?: boolean;
  /** Scrolls in the height it is given; the sheet scrolls as a whole instead. */
  grow?: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = referencesMatching(references, query);
  const openId = open ? referenceId(open) : null;

  const group = (title: string, refs: readonly GridReference[]) => refs.length > 0 && (
    <>
      <div className={cn(
        "px-3 pt-1.5 pb-0.5 text-[10.5px] font-semibold tracking-[0.05em] whitespace-nowrap text-text-3 uppercase",
        sheet && "px-4 pt-2.5 pb-1 text-[11px]",
      )}>
        {title} ({refs.length})
      </div>
      {refs.map((ref) => {
        const id = referenceId(ref);
        const lit = id === openId;
        return (
          <div key={id} role="listitem">
            <button
              type="button" onClick={() => onOpen(ref)} aria-pressed={lit}
              title={`Show ${ref.table} below the grid, following the selected row`}
              className={cn(
                "mx-1 flex h-[26px] w-[calc(100%-8px)] items-center gap-[5px] rounded-[5px] pr-1.5 pl-0.5 text-left text-xs whitespace-nowrap text-text-2 select-none can-hover:hover:bg-surface-hover can-hover:hover:text-text",
                sheet && "mx-1.5 h-11 w-[calc(100%-12px)] gap-2.5 px-2.5 text-sm",
                lit && "bg-accent-wash text-text can-hover:hover:bg-accent-wash",
              )}
            >
              <Table className={cn("shrink-0", sheet ? "size-[18px]" : "size-[15px]", lit ? "text-primary" : "text-text-3")} aria-hidden />
              <span className="min-w-0 truncate">
                <Highlight text={ref.table} query={query} />{" "}
                <span className="font-mono text-[10.5px] text-text-3">({ref.keyColumns.join(", ")})</span>
              </span>
            </button>
          </div>
        );
      })}
    </>
  );

  return (
    <section aria-label="References" className={cn("flex min-h-0 flex-col", grow && !collapsed && "flex-1")}>
      <SectionHeader title="References" collapsed={collapsed} onToggle={() => onCollapsedChange(!collapsed)} />
      {!collapsed && (
        <>
          <div className="flex shrink-0 items-center pr-1.5 pb-1.5 pl-2">
            <SearchBox value={query} onChange={setQuery} placeholder="Search references" />
          </div>
          <div role="list" aria-label={`References of ${table}`} className={cn("min-h-0 pb-2.5", grow && "flex-1 overflow-auto")}>
            {group("References tables", shown.out)}
            {group("Dependent tables", shown.in)}
            {shown.out.length + shown.in.length === 0 && <EmptyState>No reference matches “{query.trim()}”.</EmptyState>}
          </div>
        </>
      )}
    </section>
  );
}
