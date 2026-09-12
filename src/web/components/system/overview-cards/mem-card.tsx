import { formatRam } from "@/lib/format-bytes";
import { MetricChartCanvas } from "../metric-chart-canvas";
import { CardShell } from "./card-shell";

export interface MemCardProps {
  usedMB: number;
  totalMB: number;
  percent: number;
  series: number[];
  /** Opens the Performance page on this device. */
  onOpen?: () => void;
}

export function MemCard({ usedMB, totalMB, percent, series, onOpen }: MemCardProps) {
  return (
    <CardShell
      testId="sysmon-card-mem"
      data={{ "data-mem-percent": percent }}
      onOpen={onOpen}
      openLabel="Memory details"
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">Memory</h3>
        <span className="text-2xl font-semibold">{percent.toFixed(1)}%</span>
      </div>
      <MetricChartCanvas
        series={[{ data: series, color: "var(--color-primary)" }]}
        height={56}
        maxValue={100}
        grid
      />
      <p className="text-[11px] text-text-subtle">
        {formatRam(usedMB)} / {formatRam(totalMB)}
      </p>
    </CardShell>
  );
}
