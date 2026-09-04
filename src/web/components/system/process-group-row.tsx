import { ChevronRight, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRam } from "@/lib/format-bytes";
import { cpuColor, formatDiskCell, formatGpuCell, formatNetCell, sumOptionalBps } from "./process-row-format";
import { optionalCellClassName, type ProcessGridResult } from "./process-columns-grid";
import type { ProcessGroup } from "../../../types/system-metrics";

const PROTECTED_GROUP_TOOLTIP = "Protected: this app contains a PPM or OS-critical process — cannot be ended as a whole.";

export interface ProcessGroupRowProps {
  group: ProcessGroup;
  expanded: boolean;
  grid: ProcessGridResult;
  /** True when any member is refused by the kill guard — the whole-app button is disabled. */
  killProtected: boolean;
  onToggle: (key: string) => void;
  onKillClick: (group: ProcessGroup) => void;
}

export function ProcessGroupRow({ group, expanded, grid, killProtected, onToggle, onKillClick }: ProcessGroupRowProps) {
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div
      className="grid items-center gap-1 min-h-11 md:min-h-7 px-3 text-xs cursor-pointer hover:bg-surface-hover transition-colors group/proc grid-cols-[var(--sysmon-grid-n)] @lg:grid-cols-[var(--sysmon-grid-w)]"
      onClick={() => onToggle(group.key)}
      data-testid="sysmon-group-row"
      data-group-key={group.key}
      data-count={group.count}
      data-disk-bps={sumOptionalBps(group.diskReadBps, group.diskWriteBps)}
      data-gpu-pct={group.gpuPct}
      data-net-bps={sumOptionalBps(group.netInBps, group.netOutBps)}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(group.key);
          }}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${group.label}`}
          data-testid="sysmon-group-expand"
          className="flex items-center justify-center size-11 md:size-7 -ml-2 shrink-0"
        >
          <Chevron className="size-3.5 text-text-subtle" />
        </button>
        <span className="truncate font-medium">{group.label}</span>
        <span className="text-text-subtle shrink-0">({group.count})</span>
      </div>
      <span className={cn("text-right", cpuColor(group.cpu))}>{group.cpu.toFixed(1)}%</span>
      <span className="text-right text-text-secondary">{formatRam(group.ramMB)}</span>
      {grid.columns.disk && (
        <span className={cn("text-right text-text-secondary tabular-nums truncate", optionalCellClassName(grid, "disk"))}>
          {formatDiskCell(group.diskReadBps, group.diskWriteBps)}
        </span>
      )}
      {grid.columns.gpu && (
        <span className={cn("text-right text-text-secondary tabular-nums truncate", optionalCellClassName(grid, "gpu"))}>
          {formatGpuCell(group.gpuPct, group.gpuMemMB)}
        </span>
      )}
      {grid.columns.net && (
        <span className={cn("text-right text-text-secondary tabular-nums truncate", optionalCellClassName(grid, "net"))}>
          {formatNetCell(group.netInBps, group.netOutBps)}
        </span>
      )}
      {/* Same 44px track as the leaf rows' kill button, so ending a whole app (Notion
          and its 7 helpers) is one click instead of seven. */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onKillClick(group);
          }}
          disabled={killProtected}
          aria-label={`End ${group.label} and its ${group.count} processes`}
          title={killProtected ? PROTECTED_GROUP_TOOLTIP : `End ${group.label} (${group.count} processes)`}
          data-testid="sysmon-group-kill-btn"
          className={cn(
            "flex items-center justify-center size-11 md:size-7 rounded transition-all",
            "can-hover:opacity-0 can-hover:group-hover/proc:opacity-100",
            killProtected
              ? "opacity-40 cursor-not-allowed"
              : "hover:bg-error/20 hover:text-error active:bg-error/30",
          )}
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
