import { useState, useEffect, useMemo } from "react";
import { Loader2 } from "lucide-react";
import { getUsageHistory, type UsageSnapshot } from "../../lib/api-settings";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => i);

type ViewMode = "5h" | "weekly";

interface AggregatedCell {
  sum: number;
  count: number;
  avg: number;
}

/** Aggregate snapshots into a 7×24 grid (day-of-week × hour-of-day) */
function buildHeatmap(snapshots: UsageSnapshot[], mode: ViewMode): AggregatedCell[][] {
  // grid[dayOfWeek 0-6][hour 0-23]
  const grid: AggregatedCell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ sum: 0, count: 0, avg: 0 })),
  );

  for (const snap of snapshots) {
    const val = mode === "5h" ? snap.five_hour_util : snap.weekly_util;
    if (val == null) continue;
    const d = new Date(snap.recorded_at + (snap.recorded_at.endsWith("Z") ? "" : "Z"));
    const dow = (d.getDay() + 6) % 7; // Monday=0
    const hour = d.getHours();
    grid[dow]![hour]!.sum += val;
    grid[dow]![hour]!.count += 1;
  }

  // Compute averages
  for (const row of grid) {
    for (const cell of row) {
      cell.avg = cell.count > 0 ? cell.sum / cell.count : 0;
    }
  }
  return grid;
}

/** Aggregate snapshots by day-of-week (average utilization) */
function buildDayAvg(grid: AggregatedCell[][]): number[] {
  return grid.map((row) => {
    const totalSum = row.reduce((s, c) => s + c.sum, 0);
    const totalCount = row.reduce((s, c) => s + c.count, 0);
    return totalCount > 0 ? totalSum / totalCount : 0;
  });
}

/** Aggregate snapshots by hour-of-day (average utilization) */
function buildHourAvg(grid: AggregatedCell[][]): number[] {
  return HOUR_LABELS.map((h) => {
    let sum = 0, count = 0;
    for (const row of grid) {
      sum += row[h]!.sum;
      count += row[h]!.count;
    }
    return count > 0 ? sum / count : 0;
  });
}

function cellColor(val: number): string {
  if (val === 0) return "bg-surface-elevated";
  if (val < 0.3) return "bg-green-500/30";
  if (val < 0.5) return "bg-green-500/60";
  if (val < 0.7) return "bg-amber-500/50";
  if (val < 0.9) return "bg-amber-500/80";
  return "bg-red-500/80";
}

function barColor(val: number): string {
  if (val < 0.3) return "bg-green-500";
  if (val < 0.7) return "bg-amber-500";
  return "bg-red-500";
}

export function UsagePatternChart({ accountId }: { accountId: string }) {
  const [snapshots, setSnapshots] = useState<UsageSnapshot[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<ViewMode>("5h");

  useEffect(() => {
    setLoading(true);
    getUsageHistory(accountId)
      .then(setSnapshots)
      .catch(() => setSnapshots([]))
      .finally(() => setLoading(false));
  }, [accountId]);

  const grid = useMemo(() => snapshots ? buildHeatmap(snapshots, mode) : null, [snapshots, mode]);
  const dayAvg = useMemo(() => grid ? buildDayAvg(grid) : [], [grid]);
  const hourAvg = useMemo(() => grid ? buildHourAvg(grid) : [], [grid]);
  const maxDay = Math.max(...dayAvg, 0.01);
  const maxHour = Math.max(...hourAvg, 0.01);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-3">
        <Loader2 className="size-3 animate-spin text-text-subtle" />
      </div>
    );
  }

  if (!snapshots || snapshots.length === 0) {
    return (
      <div className="text-[10px] text-text-subtle py-2 text-center">
        No usage history yet
      </div>
    );
  }

  const dataPoints = snapshots.length;
  const daysWithData = new Set(snapshots.map((s) => new Date(s.recorded_at + (s.recorded_at.endsWith("Z") ? "" : "Z")).toDateString())).size;

  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-text-subtle">Usage Pattern (7d)</span>
        <div className="flex gap-0.5 text-[9px]">
          <button
            onClick={() => setMode("5h")}
            className={`px-1.5 py-0.5 rounded cursor-pointer transition-colors ${mode === "5h" ? "bg-primary/15 text-primary" : "text-text-subtle hover:text-text-secondary"}`}
            title="5-hour rolling window limit — resets every 5 hours"
          >
            5h
          </button>
          <button
            onClick={() => setMode("weekly")}
            className={`px-1.5 py-0.5 rounded cursor-pointer transition-colors ${mode === "weekly" ? "bg-primary/15 text-primary" : "text-text-subtle hover:text-text-secondary"}`}
            title="Weekly limit — resets every 7 days"
          >
            Wk
          </button>
        </div>
      </div>

      {/* Explanation */}
      <p className="text-[9px] text-text-subtle leading-tight">
        Avg {mode === "5h" ? "5-hour" : "weekly"} limit usage over {daysWithData}d ({dataPoints} samples). Higher % = closer to rate limit. Hover cells for details.
      </p>

      {/* Day of week bars */}
      <div>
        <span className="text-[9px] text-text-subtle">Avg usage by day of week</span>
        <div className="flex flex-col gap-[2px] mt-0.5">
          {DAY_LABELS.map((label, i) => {
            const val = dayAvg[i] ?? 0;
            return (
              <div key={label} className="flex items-center gap-1">
                <span className="text-[8px] text-text-subtle w-5 shrink-0 text-right tabular-nums">{label}</span>
                <div className="flex-1 h-2.5 bg-surface-elevated rounded-sm overflow-hidden">
                  <div
                    className={`h-full rounded-sm transition-all ${barColor(val)}`}
                    style={{ width: `${Math.round((val / maxDay) * 100)}%` }}
                  />
                </div>
                <span className="text-[8px] text-text-subtle w-6 shrink-0 text-right tabular-nums">
                  {Math.round(val * 100)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Hour of day heatmap */}
      <div>
        <span className="text-[9px] text-text-subtle">Avg usage by hour (0h-23h)</span>
        <div className="flex gap-[1px] mt-0.5">
          {HOUR_LABELS.map((h) => {
            const val = hourAvg[h] ?? 0;
            return (
              <div key={h} className="flex-1 flex flex-col items-center gap-[1px]">
                <div
                  className={`w-full aspect-square rounded-[2px] ${cellColor(val)}`}
                  title={`${h}:00 — avg ${Math.round(val * 100)}% usage`}
                />
                {h % 6 === 0 && (
                  <span className="text-[7px] text-text-subtle tabular-nums">{h}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Heatmap: day × hour grid */}
      {grid && (
        <div>
          <span className="text-[9px] text-text-subtle">Day x Hour heatmap</span>
          <div className="flex flex-col gap-[1px] mt-0.5">
            {DAY_LABELS.map((label, d) => (
              <div key={label} className="flex items-center gap-[1px]">
                <span className="text-[7px] text-text-subtle w-4 shrink-0 text-right">{label.charAt(0)}</span>
                {HOUR_LABELS.map((h) => {
                  const cell = grid[d]![h]!;
                  return (
                    <div
                      key={h}
                      className={`flex-1 aspect-square rounded-[1px] ${cellColor(cell.avg)}`}
                      title={`${label} ${h}:00 — ${cell.count > 0 ? `avg ${Math.round(cell.avg * 100)}% (${cell.count} samples)` : "no data"}`}
                    />
                  );
                })}
              </div>
            ))}
            {/* Hour axis labels for heatmap */}
            <div className="flex items-center gap-[1px]">
              <span className="w-4 shrink-0" />
              {HOUR_LABELS.map((h) => (
                <div key={h} className="flex-1 text-center">
                  {h % 6 === 0 && <span className="text-[7px] text-text-subtle tabular-nums">{h}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Color legend */}
      <div className="flex items-center gap-1.5 text-[8px] text-text-subtle">
        <span>Low</span>
        <div className="flex gap-[2px]">
          <div className="size-2 rounded-[1px] bg-green-500/30" />
          <div className="size-2 rounded-[1px] bg-green-500/60" />
          <div className="size-2 rounded-[1px] bg-amber-500/50" />
          <div className="size-2 rounded-[1px] bg-amber-500/80" />
          <div className="size-2 rounded-[1px] bg-red-500/80" />
        </div>
        <span>High</span>
        <span className="ml-1">|</span>
        <div className="size-2 rounded-[1px] bg-surface-elevated border border-border/30" />
        <span>No data</span>
      </div>
    </div>
  );
}
