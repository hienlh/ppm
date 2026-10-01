/** Fans — Mission Center's Fan page. One row per tachometer, with the duty cycle
 *  and the temperature the same chip reports beside it. A Mac's SMC reports
 *  neither — only the speeds its controller keeps each fan between — so there the
 *  row shows those instead. */
import { formatTemp } from "@/lib/temperature";
import { useSettingsStore } from "@/stores/settings-store";
import { DetailHeader, Stat, StatGrid } from "./detail-parts";
import type { FanMetrics, MetricsPlatform } from "../../../../types/system-metrics";

const rpm = (value: number | undefined) => (value === undefined ? undefined : `${value} RPM`);

export function FansDetail({ fans, platform }: { fans: readonly FanMetrics[]; platform?: MetricsPlatform }) {
  const tempUnit = useSettingsStore((s) => s.sysmonTempUnit);
  const mac = platform === "darwin";
  const fastest = fans.length > 0 ? Math.max(...fans.map((f) => f.rpm)) : 0;
  return (
    <div className="space-y-4" data-testid="sysmon-detail-fans" data-fan-count={fans.length}>
      <DetailHeader
        title="Fans"
        subtitle={`${fans.length} sensor${fans.length === 1 ? "" : "s"}`}
        value={`${fastest} RPM`}
      />
      <div className="rounded-md border border-border divide-y divide-border">
        {fans.map((fan) => (
          <div key={fan.id} className="px-3 py-2 space-y-2" data-testid="sysmon-fan-row">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium truncate" title={fan.id}>{fan.label}</span>
              <span className="text-sm tabular-nums shrink-0">{fan.rpm} RPM</span>
            </div>
            <StatGrid>
              {mac ? (
                <>
                  <Stat label="Minimum" value={rpm(fan.minRpm)} />
                  <Stat label="Maximum" value={rpm(fan.maxRpm)} />
                </>
              ) : (
                <>
                  <Stat label="Duty cycle" value={fan.pwmPercent === undefined ? undefined
                    : `${fan.pwmPercent.toFixed(0)}%`} />
                  <Stat label={fan.tempName ?? "Temperature"} value={formatTemp(fan.tempC, tempUnit)} />
                </>
              )}
            </StatGrid>
          </div>
        ))}
      </div>
    </div>
  );
}
