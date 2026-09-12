import { MetricChartCanvas } from "../metric-chart-canvas";
import { CpuCoreBars } from "../cpu-core-bars";
import { CardShell } from "./card-shell";

export interface CpuCardProps {
  total: number;
  cores: number[];
  model: string;
  series: number[];
  /** Opens the Performance page on this device. */
  onOpen?: () => void;
}

function cpuColor(pct: number): string {
  if (pct > 80) return "text-error";
  if (pct > 50) return "text-warning";
  return "text-success";
}

export function CpuCard({ total, cores, model, series, onOpen }: CpuCardProps) {
  return (
    <CardShell
      testId="sysmon-card-cpu"
      data={{ "data-cpu-total": total }}
      onOpen={onOpen}
      openLabel="CPU details"
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">CPU</h3>
        <span className={`text-2xl font-semibold ${cpuColor(total)}`}>{total.toFixed(1)}%</span>
      </div>
      <MetricChartCanvas
        series={[{ data: series, color: "var(--color-primary)" }]}
        height={56}
        maxValue={100}
        grid
      />
      <CpuCoreBars cores={cores} />
      <p className="text-[11px] text-text-subtle truncate" title={model}>
        {model}
      </p>
    </CardShell>
  );
}
