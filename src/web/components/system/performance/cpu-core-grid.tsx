/**
 * One graph per logical processor — Mission Center's "Logical Processors" top
 * graph, which is the view that makes a hybrid part legible: on a 12900K the
 * eight P-cores and their SMT siblings move quite differently from the eight
 * E-cores, and a single overall line says none of that.
 *
 * Each cell draws its OWN history rather than a bar of the current value, so a
 * thread that spiked two seconds ago is still visible — which is the whole point
 * of a graph over a meter.
 */
import { useRef, useMemo } from "react";
import { useElementWidth } from "@/hooks/use-element-width";
import { coreGridLayout } from "@/lib/cpu-graph-mode";
import { MetricChartCanvas } from "../metric-chart-canvas";
import { CHART_COLORS } from "./detail-parts";
import type { MetricsHistoryPoint } from "../../../../types/system-metrics";

export interface CpuCoreGridProps {
  /** Current reading per logical processor — the length is what decides the grid. */
  cores: readonly number[];
  history: readonly MetricsHistoryPoint[];
  points?: number;
  /** Total height the grid may use; each row gets an equal share. */
  height?: number;
}

export function CpuCoreGrid({ cores, history, points = 200, height = 260 }: CpuCoreGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const { cols, rows } = coreGridLayout(cores.length, width);

  // One pass over the window building every cell's series together, rather than
  // twenty-four separate `.map`s over the same 200 points on every tick.
  const series = useMemo(() => {
    const window = history.slice(-points);
    const out: number[][] = Array.from({ length: cores.length }, () => []);
    for (const point of window) {
      const values = point.system.cpu.cores;
      for (let i = 0; i < out.length; i++) out[i]!.push(values[i] ?? 0);
    }
    return out;
  }, [history, points, cores.length]);

  if (cores.length === 0) return null;

  // A cell is short; the ruled background would be denser than the curve, so only
  // the frame is drawn and the grid stays on the full-width graphs.
  const cellHeight = Math.max(28, Math.floor(height / Math.max(1, rows)) - 6);

  return (
    <div
      ref={ref}
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${Math.max(1, cols)}, minmax(0, 1fr))` }}
      data-testid="sysmon-core-grid"
      data-core-count={cores.length}
      data-cols={cols}
    >
      {series.map((data, i) => (
        <div
          key={i}
          className="rounded-sm border border-border/70 overflow-hidden px-0.5"
          title={`CPU ${i}: ${(cores[i] ?? 0).toFixed(0)}%`}
        >
          <MetricChartCanvas
            series={[{ data, color: CHART_COLORS.primary }]}
            height={cellHeight}
            maxValue={100}
          />
        </div>
      ))}
    </div>
  );
}
