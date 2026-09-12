import { formatBps } from "@/lib/format-bytes";
import { MetricChartCanvas } from "../metric-chart-canvas";
import { CardShell } from "./card-shell";

export interface DiskCardProps {
  available: boolean;
  inBps: number;
  outBps: number;
  readSeries: number[];
  writeSeries: number[];
  /** True while the stream has not yet delivered a second tick — a rate needs two
   *  samples, so `available:false` here is expected, not a missing collector. */
  measuring?: boolean;
  /** Opens the Performance page on the busiest device of this kind. */
  onOpen?: () => void;
}

export function DiskCard({ available, inBps, outBps, readSeries, writeSeries, measuring, onOpen }: DiskCardProps) {
  return (
    <CardShell
      testId="sysmon-card-disk"
      data={{ "data-available": available }}
      onOpen={onOpen}
      openLabel="Disk details"
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
            grid
          />
          <p className="text-[11px] text-text-subtle">
            Read {formatBps(inBps)} · Write {formatBps(outBps)}
          </p>
        </>
      ) : (
        <p className="text-[11px] text-text-subtle">{measuring ? "measuring…" : "n/a"}</p>
      )}
    </CardShell>
  );
}
