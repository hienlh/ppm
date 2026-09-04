import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRam } from "@/lib/format-bytes";
import { cpuColor, formatDiskCell, formatGpuCell, formatNetCell } from "./process-row-format";
import { optionalCellClassName, PROCESS_ROW_GRID_CLASS, type ProcessGridResult } from "./process-columns-grid";
import type { Totals } from "./process-table-totals";
import { SortableHeader, type ColumnResizeHandlers } from "./sortable-header";
import type { SortDir, SortKey } from "../../../types/system-metrics";

const SEARCH_DEBOUNCE_MS = 150;

export interface ProcessTableToolbarProps {
  mode: "grouped" | "flat";
  onModeChange: (mode: "grouped" | "flat") => void;
  ppmOnly: boolean;
  onPpmOnlyChange: (v: boolean) => void;
  onQueryChange: (query: string) => void;
}

/** Search/mode/PPM controls. Debounces the query locally so typing does not rebuild
 *  up to 1000 rows on every keystroke. */
export function ProcessTableToolbar({
  mode,
  onModeChange,
  ppmOnly,
  onPpmOnlyChange,
  onQueryChange,
}: ProcessTableToolbarProps) {
  const [draft, setDraft] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onQueryChange(draft), SEARCH_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onQueryChange identity may churn; only `draft` should retrigger
  }, [draft]);

  return (
    <div className="flex flex-wrap items-center gap-2 p-2 border-b border-border shrink-0">
      <div className="relative flex-1 min-w-[140px]">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-text-subtle" />
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search processes"
          aria-label="Search processes"
          data-testid="sysmon-process-search"
          className="w-full min-h-11 md:min-h-8 pl-7 pr-2 text-sm rounded-md border border-border bg-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <button
        type="button"
        onClick={() => onModeChange(mode === "grouped" ? "flat" : "grouped")}
        aria-pressed={mode === "flat"}
        data-testid="sysmon-toggle-flat"
        className="min-h-11 md:min-h-8 px-3 text-xs rounded-md border border-border hover:bg-surface-hover transition-colors"
      >
        {mode === "flat" ? "Flat" : "Grouped"}
      </button>
      <button
        type="button"
        onClick={() => onPpmOnlyChange(!ppmOnly)}
        aria-pressed={ppmOnly}
        data-testid="sysmon-filter-ppm"
        className={cn(
          "min-h-11 md:min-h-8 px-3 text-xs rounded-md border transition-colors",
          ppmOnly ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-surface-hover",
        )}
      >
        PPM only
      </button>
    </div>
  );
}

export interface ProcessTableHeaderProps {
  sortKey: SortKey;
  sortDir: SortDir;
  grid: ProcessGridResult;
  onSort: (field: Exclude<SortKey, null>) => void;
  resize: ColumnResizeHandlers;
}

/** Sticky column header row, grid-aligned with the rows below it. Disk/GPU/Net
 *  headers only render when the host reported that column as measurable
 *  (`grid.columns.<x>`); below `@lg` only the one currently sorted survives. Every
 *  fixed-width column carries a drag handle on its right edge. */
export function ProcessTableHeader({ sortKey, sortDir, grid, onSort, resize }: ProcessTableHeaderProps) {
  const common = { activeKey: sortKey, activeDir: sortDir, onClick: onSort, resize };
  return (
    <div
      role="row"
      className={cn(
        "grid gap-1 px-3 py-1.5 text-[11px] text-text-subtle border-b border-border sticky top-0 bg-background z-10",
        PROCESS_ROW_GRID_CLASS,
      )}
    >
      <SortableHeader label="Process" field="name" {...common} resize={undefined} align="left" testId="sysmon-sort-name" />
      <SortableHeader label="CPU" field="cpu" {...common} resizeKey="cpu" testId="sysmon-sort-cpu" />
      <SortableHeader label="RAM" field="ram" {...common} resizeKey="ram" testId="sysmon-sort-ram" />
      {grid.columns.disk && (
        <SortableHeader label="Disk" field="disk" {...common} resizeKey="disk" testId="sysmon-col-disk" className={optionalCellClassName(grid, "disk")} />
      )}
      {grid.columns.gpu && (
        <SortableHeader label="GPU" field="gpu" {...common} resizeKey="gpu" testId="sysmon-col-gpu" className={optionalCellClassName(grid, "gpu")} />
      )}
      {grid.columns.net && (
        <SortableHeader label="Net" field="net" {...common} resizeKey="net" testId="sysmon-col-net" className={optionalCellClassName(grid, "net")} />
      )}
      <span />
    </div>
  );
}

export interface ProcessTableFooterProps {
  totals: Totals;
  grid: ProcessGridResult;
  /** `system.gpus[0]?.utilPercent` — a whole-machine reading, not a sum of the
   *  visible rows' `gpuPct` (per-process GPU% can double-count shared engines). */
  gpuUtilPercent?: number;
}

export function ProcessTableFooter({ totals, grid, gpuUtilPercent }: ProcessTableFooterProps) {
  return (
    <div
      className={cn(
        "grid gap-1 px-3 py-1.5 text-xs font-medium border-t border-border shrink-0",
        PROCESS_ROW_GRID_CLASS,
      )}
      data-testid="sysmon-total"
      data-process-count={totals.count}
    >
      <span className="truncate">Total ({totals.count} processes)</span>
      <span className={cn("text-right", cpuColor(totals.cpu))}>{totals.cpu.toFixed(1)}%</span>
      <span className="text-right text-text-secondary">{formatRam(totals.ramMB)}</span>
      {grid.columns.disk && (
        <span className={cn("text-right text-text-secondary tabular-nums truncate", optionalCellClassName(grid, "disk"))}>
          {formatDiskCell(totals.diskReadBps, totals.diskWriteBps)}
        </span>
      )}
      {grid.columns.gpu && (
        <span className={cn("text-right text-text-secondary tabular-nums truncate", optionalCellClassName(grid, "gpu"))}>
          {formatGpuCell(gpuUtilPercent, totals.gpuMemMB)}
        </span>
      )}
      {grid.columns.net && (
        <span className={cn("text-right text-text-secondary tabular-nums truncate", optionalCellClassName(grid, "net"))}>
          {formatNetCell(totals.netInBps, totals.netOutBps)}
        </span>
      )}
      <span />
    </div>
  );
}
