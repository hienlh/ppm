import { formatRam } from "@/lib/format-bytes";
import { MetricChartCanvas } from "../metric-chart-canvas";

export interface GpuCardProps {
  name: string;
  utilPercent: number;
  vramUsedMB: number;
  vramTotalMB: number;
  series: number[];
}

/** One card per GPU. The caller (`overview-panel.tsx`) renders zero of these when
 *  `system.gpus` is empty — hide, never a disabled placeholder card. */
export function GpuCard({ name, utilPercent, vramUsedMB, vramTotalMB, series }: GpuCardProps) {
  return (
    <div className="rounded-lg border border-border p-4 space-y-2" data-testid="sysmon-card-gpu">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium truncate" title={name}>
          {name}
        </h3>
        <span className="text-2xl font-semibold shrink-0">{utilPercent.toFixed(0)}%</span>
      </div>
      <MetricChartCanvas
        series={[{ data: series, color: "var(--color-primary)" }]}
        height={56}
        maxValue={100}
      />
      <p className="text-[11px] text-text-subtle">
        VRAM {formatRam(vramUsedMB)} / {formatRam(vramTotalMB)}
      </p>
    </div>
  );
}
