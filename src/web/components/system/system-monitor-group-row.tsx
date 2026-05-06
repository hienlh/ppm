import { memo, useMemo } from "react";
import { ChevronRight, ChevronDown, HelpCircle, X, ArrowUp, ArrowDown } from "lucide-react";
import type { ResourceGroup } from "@/hooks/use-resource-monitor";
import { SparklineCanvas } from "./sparkline-canvas";
import { cn } from "@/lib/utils";

export type SortKey = "cpu" | "ram" | null;
export type SortDir = "asc" | "desc";

function cpuColor(cpu: number) {
  if (cpu > 80) return "text-red-500";
  if (cpu > 50) return "text-yellow-500";
  return "text-green-500";
}

function formatRam(mb: number) {
  return mb < 1024 ? `${mb.toFixed(0)} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

function formatAge(startedAt?: number) {
  if (!startedAt) return "";
  const secs = Math.round((Date.now() - startedAt) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

export interface GroupRowProps {
  group: ResourceGroup;
  Icon: React.ElementType;
  isExpanded: boolean;
  sparkData: number[];
  isMobile: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  onToggle: () => void;
  onKill: (pid: number) => void;
}

export const GroupRow = memo(function GroupRow({
  group, Icon, isExpanded, sparkData, isMobile, sortKey, sortDir, onToggle, onKill,
}: GroupRowProps) {
  const Chevron = isExpanded ? ChevronDown : ChevronRight;

  const sortedProcesses = useMemo(() => {
    if (!sortKey) return group.processes;
    return [...group.processes].sort((a, b) => {
      const av = sortKey === "cpu" ? a.cpu : a.ramMB;
      const bv = sortKey === "cpu" ? b.cpu : b.ramMB;
      return sortDir === "asc" ? av - bv : bv - av;
    });
  }, [group.processes, sortKey, sortDir]);

  return (
    <>
      <tr
        className="hover:bg-surface-hover cursor-pointer transition-colors"
        onClick={onToggle}
      >
        <td className="py-1.5 px-3">
          <div className="flex items-center gap-1.5">
            <Chevron className="size-3 text-text-subtle shrink-0" />
            <Icon className="size-3.5 text-text-secondary shrink-0" />
            <span className="truncate">{group.label}</span>
            <span className="text-text-subtle">({group.processes.length})</span>
          </div>
        </td>
        <td className={cn("text-right py-1.5 px-2", cpuColor(group.cpu))}>
          {group.cpu.toFixed(1)}%
        </td>
        <td className="text-right py-1.5 px-2 text-text-secondary">
          {formatRam(group.ramMB)}
        </td>
        {!isMobile && (
          <td className="py-1.5 px-2">
            {sparkData.length > 1 && (
              <SparklineCanvas data={sparkData} width={120} height={20} />
            )}
          </td>
        )}
      </tr>
      {isExpanded && sortedProcesses.map((proc) => (
        <tr key={proc.pid} className="text-text-subtle group/proc hover:bg-surface-hover transition-colors">
          <td className="py-1 px-3 pl-10">
            <div className="flex items-start gap-1.5">
              <span className="text-text-subtle shrink-0">{proc.pid}</span>
              <span className="break-all text-text-secondary" title={proc.command}>
                {proc.command}
              </span>
            </div>
          </td>
          <td className="text-right py-1 px-2 align-top">{proc.cpu.toFixed(1)}%</td>
          <td className="text-right py-1 px-2 align-top">{formatRam(proc.ramMB)}</td>
          {!isMobile && (
            <td className="align-top py-1 px-2">
              <div className="flex items-center justify-between gap-1">
                <span
                  className="text-text-subtle"
                  title={proc.startedAt ? new Date(proc.startedAt).toLocaleString() : ""}
                >
                  {formatAge(proc.startedAt)}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); onKill(proc.pid); }}
                  className="opacity-0 group-hover/proc:opacity-100 p-0.5 rounded hover:bg-red-500/20 hover:text-red-500 transition-all"
                  title={`End process ${proc.pid}`}
                >
                  <X className="size-3" />
                </button>
              </div>
            </td>
          )}
        </tr>
      ))}
    </>
  );
});

// ── Sortable column header ─────────────────────────────────────────────

export function SortableHeader({ label, field, activeKey, activeDir, onClick, className }: {
  label: string;
  field: "cpu" | "ram";
  activeKey: SortKey;
  activeDir: SortDir;
  onClick: (field: "cpu" | "ram") => void;
  className?: string;
}) {
  const isActive = activeKey === field;
  const Arrow = isActive ? (activeDir === "asc" ? ArrowUp : ArrowDown) : null;

  return (
    <th
      className={cn(
        "text-right py-1.5 px-2 font-medium cursor-pointer select-none hover:text-text-primary transition-colors",
        isActive && "text-text-primary",
        className,
      )}
      onClick={() => onClick(field)}
    >
      <div className="flex items-center justify-end gap-0.5">
        <span>{label}</span>
        {Arrow && <Arrow className="size-3" />}
      </div>
    </th>
  );
}

export { cpuColor, formatRam };
