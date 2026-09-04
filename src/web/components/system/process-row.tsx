import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRam } from "@/lib/format-bytes";
import { cpuColor, formatAge, formatDiskCell, formatGpuCell, formatNetCell, sumOptionalBps } from "./process-row-format";
import { optionalCellClassName, type ProcessGridResult } from "./process-columns-grid";
import type { ProcessInfo } from "../../../types/system-metrics";

const PROTECTED_TOOLTIP = "Protected: PPM or OS-critical process — cannot be ended.";

export interface ProcessRowProps {
  proc: ProcessInfo;
  indent: boolean;
  grid: ProcessGridResult;
  onKillClick: (proc: ProcessInfo) => void;
}

export function ProcessRow({ proc, indent, grid, onKillClick }: ProcessRowProps) {
  return (
    <div
      className="grid items-center gap-1 min-h-11 md:min-h-7 px-3 text-xs group/proc hover:bg-surface-hover transition-colors grid-cols-[var(--sysmon-grid-n)] @lg:grid-cols-[var(--sysmon-grid-w)]"
      data-testid="sysmon-process-row"
      data-pid={proc.pid}
      data-ppm={proc.ppm}
      data-protected={proc.protected}
      data-disk-bps={sumOptionalBps(proc.diskReadBps, proc.diskWriteBps)}
      data-gpu-pct={proc.gpuPct}
      data-net-bps={sumOptionalBps(proc.netInBps, proc.netOutBps)}
    >
      <div className={cn("flex items-start gap-1.5 min-w-0", indent && "pl-6")}>
        <span className="text-text-subtle shrink-0">{proc.pid}</span>
        <span className="truncate text-text-secondary" title={proc.command}>
          {proc.command}
        </span>
      </div>
      <span className={cn("text-right", cpuColor(proc.cpu))}>{proc.cpu.toFixed(1)}%</span>
      <span className="text-right text-text-secondary">{formatRam(proc.ramMB)}</span>
      {grid.columns.disk && (
        <span className={cn("text-right text-text-secondary tabular-nums truncate", optionalCellClassName(grid, "disk"))}>
          {formatDiskCell(proc.diskReadBps, proc.diskWriteBps)}
        </span>
      )}
      {grid.columns.gpu && (
        <span className={cn("text-right text-text-secondary tabular-nums truncate", optionalCellClassName(grid, "gpu"))}>
          {formatGpuCell(proc.gpuPct, proc.gpuMemMB)}
        </span>
      )}
      {grid.columns.net && (
        <span className={cn("text-right text-text-secondary tabular-nums truncate", optionalCellClassName(grid, "net"))}>
          {formatNetCell(proc.netInBps, proc.netOutBps)}
        </span>
      )}
      <span
        className="hidden @lg:block text-text-subtle text-right"
        title={proc.startedAt ? new Date(proc.startedAt).toLocaleString() : ""}
      >
        {formatAge(proc.startedAt || undefined)}
      </span>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onKillClick(proc);
          }}
          disabled={proc.protected}
          aria-label={`End process ${proc.name} (${proc.pid})`}
          title={proc.protected ? PROTECTED_TOOLTIP : `End process ${proc.name}`}
          data-testid="sysmon-kill-btn"
          className={cn(
            "flex items-center justify-center size-11 md:size-7 rounded transition-all",
            "can-hover:opacity-0 can-hover:group-hover/proc:opacity-100",
            proc.protected
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
