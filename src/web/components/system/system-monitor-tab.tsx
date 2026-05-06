import { useState, useMemo, useCallback, memo } from "react";
import {
  Server, Monitor, Bot, Hammer, HelpCircle,
  Wifi, WifiOff,
} from "lucide-react";
import { useResourceMonitor, type ResourceGroup } from "@/hooks/use-resource-monitor";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  GroupRow, SortableHeader, cpuColor, formatRam,
  type SortKey, type SortDir,
} from "./system-monitor-group-row";

const GROUP_ICONS: Record<ResourceGroup["type"], React.ElementType> = {
  server: Server,
  terminal: Monitor,
  "ai-tool": Bot,
  build: Hammer,
  unknown: HelpCircle,
};

const SPARKLINE_POINTS = 200;

function toggleSort(
  current: SortKey, dir: SortDir, clicked: "cpu" | "ram",
): [SortKey, SortDir] {
  if (current !== clicked) return [clicked, "desc"];
  if (dir === "desc") return [clicked, "asc"];
  return [null, "desc"]; // third click resets
}

function sortGroups(groups: ResourceGroup[], key: SortKey, dir: SortDir) {
  if (!key) return groups;
  const sorted = [...groups].sort((a, b) => {
    const av = key === "cpu" ? a.cpu : a.ramMB;
    const bv = key === "cpu" ? b.cpu : b.ramMB;
    return dir === "asc" ? av - bv : bv - av;
  });
  return sorted;
}

export const SystemMonitorTab = memo(function SystemMonitorTab() {
  const { latest, history, isConnected } = useResourceMonitor();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["server"]));
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const isMobile = useIsMobile();

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

  const sortedGroups = useMemo(() => {
    if (!latest) return [];
    return sortGroups(latest.groups, sortKey, sortDir);
  }, [latest, sortKey, sortDir]);

  const killProcess = useCallback(async (pid: number) => {
    try {
      await api.post(`/api/system/resources/kill/${pid}`);
      toast.success(`Sent SIGTERM to PID ${pid}`);
    } catch (e: any) {
      toast.error(e.message || `Failed to kill PID ${pid}`);
    }
  }, []);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSort = (clicked: "cpu" | "ram") => {
    const [newKey, newDir] = toggleSort(sortKey, sortDir, clicked);
    setSortKey(newKey);
    setSortDir(newDir);
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
              <SortableHeader
                label="CPU"
                field="cpu"
                activeKey={sortKey}
                activeDir={sortDir}
                onClick={handleSort}
                className="w-16"
              />
              <SortableHeader
                label="RAM"
                field="ram"
                activeKey={sortKey}
                activeDir={sortDir}
                onClick={handleSort}
                className="w-20"
              />
              {!isMobile && (
                <th className="py-1.5 px-2 font-medium w-[130px]">Trend / Age</th>
              )}
            </tr>
          </thead>
          <tbody>
            {sortedGroups.map((group) => {
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
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={() => toggle(key)}
                  onKill={killProcess}
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
