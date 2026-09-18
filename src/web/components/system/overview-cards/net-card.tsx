import { formatBps } from "@/lib/format-bytes";
import { MetricChartCanvas } from "../metric-chart-canvas";
import { CardShell } from "./card-shell";

export interface NetCardProps {
  available: boolean;
  inBps: number;
  outBps: number;
  downSeries: number[];
  upSeries: number[];
  /** True while the stream has not yet delivered a second tick — a rate needs two
   *  samples, so `available:false` here is expected, not a missing collector. */
  measuring?: boolean;
  /** Opens the Performance page on the busiest device of this kind. */
  onOpen?: () => void;
}

export function NetCard({ available, inBps, outBps, downSeries, upSeries, measuring, onOpen }: NetCardProps) {
  return (
    <CardShell
      testId="sysmon-card-net"
      data={{ "data-available": available }}
      onOpen={onOpen}
      openLabel="Network details"
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
            grid
          />
          <p className="text-[11px] text-text-subtle">
            Down {formatBps(inBps)} · Up {formatBps(outBps)}
          </p>
        </>
      ) : (
        <p className="text-[11px] text-text-subtle">{measuring ? "measuring…" : "n/a"}</p>
      )}
    </CardShell>
  );
}
