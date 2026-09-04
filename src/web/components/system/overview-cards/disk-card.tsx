import { formatBps } from "@/lib/format-bytes";
import { MetricChartCanvas } from "../metric-chart-canvas";

export interface DiskCardProps {
  available: boolean;
  inBps: number;
  outBps: number;
  readSeries: number[];
  writeSeries: number[];
  /** True while the stream has not yet delivered a second tick — a rate needs two
   *  samples, so `available:false` here is expected, not a missing collector. */
  measuring?: boolean;
}

export function DiskCard({ available, inBps, outBps, readSeries, writeSeries, measuring }: DiskCardProps) {
  return (
    <div
      className="rounded-lg border border-border p-4 space-y-2"
      data-testid="sysmon-card-disk"
      data-available={available}
    >
      <h3 className="text-sm font-medium">Disk</h3>
      {available ? (
        <>
          <MetricChartCanvas
            series={[
              { data: readSeries, color: "var(--color-primary)" },
              { data: writeSeries, color: "var(--color-warning)" },
            ]}
            height={56}
          />
          <p className="text-[11px] text-text-subtle">
            Read {formatBps(inBps)} · Write {formatBps(outBps)}
          </p>
        </>
      ) : (
        <p className="text-[11px] text-text-subtle">{measuring ? "measuring…" : "n/a"}</p>
      )}
    </div>
  );
}
