/** One network interface — Mission Center's per-interface page. */
import { formatBps, formatBytes } from "@/lib/format-bytes";
import { CHART_COLORS, DetailChart, DetailHeader, Stat, StatGrid, useSeries } from "./detail-parts";
import { NIC_KIND_LABELS } from "./device-list";
import type { NicInfo } from "../../../../types/system-hardware";
import type { MetricsHistoryPoint, NicMetrics, NicState } from "../../../../types/system-metrics";

const STATE_LABELS: Record<NicState, string> = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Disconnected",
  unavailable: "Unavailable",
  unknown: "Unknown",
};

export function NicDetail({
  nic, info, history,
}: { nic: NicMetrics; info?: NicInfo; history: readonly MetricsHistoryPoint[] }) {
  const pick = (p: MetricsHistoryPoint) => p.system.nics?.find((n) => n.id === nic.id);
  const rx = useSeries(history, (p) => pick(p)?.rxBps);
  const tx = useSeries(history, (p) => pick(p)?.txBps);

  return (
    <div className="space-y-4" data-testid="sysmon-detail-nic" data-nic-id={nic.id}>
      <DetailHeader
        title={NIC_KIND_LABELS[info?.kind ?? "other"]}
        subtitle={[nic.id, info?.deviceName].filter(Boolean).join(" · ")}
        value={nic.available ? formatBps(nic.rxBps + nic.txBps) : "—"}
      />
      <DetailChart
        legend={["Receive", "Send"]}
        series={[
          { data: rx, color: CHART_COLORS.primary },
          { data: tx, color: CHART_COLORS.secondary },
        ]}
      />
      <StatGrid>
        <Stat label="State" value={STATE_LABELS[nic.state]} />
        <Stat label="Receive" value={nic.available ? formatBps(nic.rxBps) : undefined} />
        <Stat label="Send" value={nic.available ? formatBps(nic.txBps) : undefined} />
        <Stat label="Maximum bitrate" value={nic.linkMbps === undefined ? undefined : `${nic.linkMbps} Mbps`} />
        <Stat label="Total received" value={formatBytes(nic.rxTotal)} />
        <Stat label="Total sent" value={formatBytes(nic.txTotal)} />
        <Stat label="Network name" value={nic.ssid} />
        <Stat label="Signal" value={nic.signalPercent === undefined ? undefined : `${nic.signalPercent}%`} />
        <Stat label="Frequency" value={nic.frequencyMHz === undefined ? undefined
          : `${(nic.frequencyMHz / 1000).toFixed(1)} GHz`} />
        <Stat label="Driver" value={info?.driver} />
        <Stat label="Hardware address" value={info?.mac} />
        <Stat label="IPv4" value={info?.ipv4.join(", ")} title={info?.ipv4.join("\n")} />
        <Stat label="IPv6" value={info?.ipv6.join(", ")} title={info?.ipv6.join("\n")} />
      </StatGrid>
    </div>
  );
}
