import { formatBps } from "@/lib/format-bytes";
import { MetricChartCanvas } from "../metric-chart-canvas";

export interface NetCardProps {
  available: boolean;
  inBps: number;
  outBps: number;
  downSeries: number[];
  upSeries: number[];
  /** True while the stream has not yet delivered a second tick — a rate needs two
   *  samples, so `available:false` here is expected, not a missing collector. */
  measuring?: boolean;
}

export function NetCard({ available, inBps, outBps, downSeries, upSeries, measuring }: NetCardProps) {
  return (
    <div
      className="rounded-lg border border-border p-4 space-y-2"
      data-testid="sysmon-card-net"
      data-available={available}
    >
      <h3 className="text-sm font-medium">Network</h3>
      {available ? (
        <>
          <MetricChartCanvas
            series={[
              { data: downSeries, color: "var(--color-primary)" },
              { data: upSeries, color: "var(--color-warning)" },
            ]}
            height={56}
          />
          <p className="text-[11px] text-text-subtle">
            Down {formatBps(inBps)} · Up {formatBps(outBps)}
          </p>
        </>
      ) : (
        <p className="text-[11px] text-text-subtle">{measuring ? "measuring…" : "n/a"}</p>
      )}
    </div>
  );
}
