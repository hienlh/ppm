import { formatRam } from "@/lib/format-bytes";
import { MetricChartCanvas } from "../metric-chart-canvas";

export interface MemCardProps {
  usedMB: number;
  totalMB: number;
  percent: number;
  series: number[];
}

export function MemCard({ usedMB, totalMB, percent, series }: MemCardProps) {
  return (
    <div
      className="rounded-lg border border-border p-4 space-y-2"
      data-testid="sysmon-card-mem"
      data-mem-percent={percent}
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">Memory</h3>
        <span className="text-2xl font-semibold">{percent.toFixed(1)}%</span>
      </div>
      <MetricChartCanvas
        series={[{ data: series, color: "var(--color-primary)" }]}
        height={56}
        maxValue={100}
      />
      <p className="text-[11px] text-text-subtle">
        {formatRam(usedMB)} / {formatRam(totalMB)}
      </p>
    </div>
  );
}
