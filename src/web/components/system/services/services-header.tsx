/**
 * The Services table's header row: the column names, and the click that sorts by
 * them.
 *
 * It is `sticky` rather than a fixed band above the scroller because the list is
 * one scroll container shared with the rows — a header that scrolls away on a
 * 222-unit list stops answering the only question it exists to answer, which is
 * what the fourth number along is.
 */
import { cn } from "@/lib/utils";
import { SortableHeader } from "../sortable-header";
import {
  SERVICE_COLUMNS, SERVICE_ROW_GRID_CLASS, columnVisibilityClass,
} from "./service-columns";
import type { ServiceSortKey } from "./service-sort";
import type { SortDir } from "../../../../types/system-metrics";

export interface ServicesHeaderProps {
  sortKey: ServiceSortKey | null;
  sortDir: SortDir;
  onSort: (key: ServiceSortKey) => void;
}

export function ServicesHeader({ sortKey, sortDir, onSort }: ServicesHeaderProps) {
  return (
    <div
      role="row"
      data-testid="sysmon-services-header"
      className={cn(
        "sticky top-0 z-10 px-3 bg-background border-b border-border text-[11px] text-text-subtle",
        SERVICE_ROW_GRID_CLASS,
      )}
    >
      {SERVICE_COLUMNS.map((column) => (
        <SortableHeader
          key={column.key}
          label={column.label}
          field={column.key}
          activeKey={sortKey}
          activeDir={sortDir}
          onClick={onSort}
          align={column.align}
          testId={`sysmon-services-sort-${column.key}`}
          // `px-0` beats the header's own `px-2`: the cells below have none, and
          // 8px of padding on one of the two is how a column stops lining up.
          className={cn("px-0", columnVisibilityClass(column))}
        />
      ))}
    </div>
  );
}
