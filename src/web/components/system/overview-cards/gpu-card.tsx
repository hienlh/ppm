import { formatRam } from "@/lib/format-bytes";
import { MetricChartCanvas } from "../metric-chart-canvas";
import { CardShell } from "./card-shell";

export interface GpuCardProps {
  name: string;
  utilPercent: number;
  vramUsedMB: number;
  vramTotalMB: number;
  series: number[];
  /** Opens the Performance page on this GPU. */
  onOpen?: () => void;
}

/** One card per GPU. The caller (`overview-panel.tsx`) renders zero of these when
 *  `system.gpus` is empty — hide, never a disabled placeholder card. */
export function GpuCard({ name, utilPercent, vramUsedMB, vramTotalMB, series, onOpen }: GpuCardProps) {
  return (
    <CardShell testId="sysmon-card-gpu" onOpen={onOpen} openLabel={`${name} details`}>
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
        grid
      />
      {/* A total of 0 is the contract's "this device has no dedicated memory" — an
          integrated GPU — not a card with an empty one. Saying "0 MB / 0 MB" states
          a measurement that was never taken, and disagrees with the Performance
          page's GPU detail, which renders the same case as an em dash. */}
      {vramTotalMB > 0 && (
        <p className="text-[11px] text-text-subtle">
          VRAM {formatRam(vramUsedMB)} / {formatRam(vramTotalMB)}
        </p>
      )}
    </CardShell>
  );
}
