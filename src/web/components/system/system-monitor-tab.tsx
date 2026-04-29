import { useState, useMemo, memo } from "react";
import {
  Server, Monitor, Bot, Hammer, HelpCircle,
  ChevronRight, ChevronDown, Wifi, WifiOff,
} from "lucide-react";
import { useResourceMonitor, type ResourceGroup } from "@/hooks/use-resource-monitor";
import { SparklineCanvas } from "./sparkline-canvas";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";

const GROUP_ICONS: Record<ResourceGroup["type"], React.ElementType> = {
  server: Server,
  terminal: Monitor,
  "ai-tool": Bot,
  build: Hammer,
  unknown: HelpCircle,
};

const SPARKLINE_POINTS = 200; // ~10 min at 3s intervals

function cpuColor(cpu: number) {
  if (cpu > 80) return "text-red-500";
  if (cpu > 50) return "text-yellow-500";
  return "text-green-500";
}

function formatRam(mb: number) {
  return mb < 1024 ? `${mb.toFixed(0)} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

export const SystemMonitorTab = memo(function SystemMonitorTab() {
  const { latest, history, isConnected } = useResourceMonitor();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["server"]));
  const isMobile = useIsMobile();

  // Extract per-group CPU history for sparklines
  const groupSparklines = useMemo(() => {
    const map = new Map<string, number[]>();
    const recentHistory = history.slice(-SPARKLINE_POINTS);
    for (const snap of recentHistory) {
      for (const group of snap.groups) {
        const key = `${group.type}:${group.label}`;
        const arr = map.get(key) ?? [];
        arr.push(group.cpu);
        map.set(key, arr);
      }
    }
    return map;
  }, [history]);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!latest) {
    return (
      <div className="flex items-center justify-center h-full text-text-subtle text-sm">
        {isConnected ? "Waiting for data..." : "Connecting to resource monitor..."}
      </div>
    );
  }

  const elapsed = Math.round((Date.now() - latest.timestamp) / 1000);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <h2 className="text-sm font-medium">System Monitor</h2>
        <div className="flex items-center gap-1.5 text-[10px] text-text-subtle">
          {isConnected
            ? <Wifi className="size-3 text-green-500" />
            : <WifiOff className="size-3 text-red-500" />}
          <span>{isConnected ? `Updated ${elapsed}s ago` : "Disconnected"}</span>
        </div>
      </div>

      {/* Group list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-subtle border-b border-border">
              <th className="text-left py-1.5 px-3 font-medium">Process</th>
              <th className="text-right py-1.5 px-2 font-medium w-16">CPU</th>
              <th className="text-right py-1.5 px-2 font-medium w-20">RAM</th>
              {!isMobile && (
                <th className="py-1.5 px-2 font-medium w-[130px]">Trend</th>
              )}
            </tr>
          </thead>
          <tbody>
            {latest.groups.map((group) => {
              const key = `${group.type}:${group.label}`;
              const Icon = GROUP_ICONS[group.type] ?? HelpCircle;
              const isExpanded = expanded.has(key);
              const sparkData = groupSparklines.get(key) ?? [];

              return (
                <GroupRow
                  key={key}
                  group={group}
                  Icon={Icon}
                  isExpanded={isExpanded}
                  sparkData={sparkData}
                  isMobile={isMobile}
                  onToggle={() => toggle(key)}
                />
              );
            })}
          </tbody>
          {/* Total row */}
          <tfoot>
            <tr className="border-t border-border font-medium">
              <td className="py-1.5 px-3">
                Total ({latest.total.processCount} processes)
              </td>
              <td className={cn("text-right py-1.5 px-2", cpuColor(latest.total.cpu))}>
                {latest.total.cpu.toFixed(1)}%
              </td>
              <td className="text-right py-1.5 px-2 text-text-secondary">
                {formatRam(latest.total.ramMB)}
              </td>
              {!isMobile && <td />}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
});

// ── Group row with collapsible children ────────────────────────────────

interface GroupRowProps {
  group: ResourceGroup;
  Icon: React.ElementType;
  isExpanded: boolean;
  sparkData: number[];
  isMobile: boolean;
  onToggle: () => void;
}

const GroupRow = memo(function GroupRow({
  group, Icon, isExpanded, sparkData, isMobile, onToggle,
}: GroupRowProps) {
  const Chevron = isExpanded ? ChevronDown : ChevronRight;

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
      {isExpanded && group.processes.map((proc) => (
        <tr key={proc.pid} className="text-text-subtle">
          <td className="py-1 px-3 pl-10">
            <span className="text-text-subtle mr-1.5">{proc.pid}</span>
            <span className="truncate">{proc.command}</span>
          </td>
          <td className="text-right py-1 px-2">{proc.cpu.toFixed(1)}%</td>
          <td className="text-right py-1 px-2">{formatRam(proc.ramMB)}</td>
          {!isMobile && <td />}
        </tr>
      ))}
    </>
  );
});
