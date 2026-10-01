/** One drive — Mission Center's per-disk page: active time, response time and the
 *  two transfer rates, over the static facts udev already knows. */
import { formatBps, formatBytes } from "@/lib/format-bytes";
import { formatTemp } from "@/lib/temperature";
import { useSettingsStore } from "@/stores/settings-store";
import { CHART_COLORS, DetailChart, DetailHeader, Stat, StatGrid, useSeries } from "./detail-parts";
import { PartitionList } from "./partition-list";
import type { DiskInfo } from "../../../../types/system-hardware";
import type { DiskMetrics, MetricsHistoryPoint } from "../../../../types/system-metrics";

const KIND_LABELS: Record<string, string> = {
  hdd: "Hard disk", ssd: "SSD", nvme: "NVMe", emmc: "eMMC",
  sd: "SD card", optical: "Optical", thumb: "Removable", unknown: "Unknown",
};

export function DiskDetail({
  disk, info, index, history,
}: { disk: DiskMetrics; info?: DiskInfo; index: number; history: readonly MetricsHistoryPoint[] }) {
  const tempUnit = useSettingsStore((s) => s.sysmonTempUnit);
  const pick = (p: MetricsHistoryPoint) => p.system.disks?.find((d) => d.id === disk.id);
  const busy = useSeries(history, (p) => pick(p)?.busyPercent);
  const read = useSeries(history, (p) => pick(p)?.readBps);
  const write = useSeries(history, (p) => pick(p)?.writeBps);

  return (
    <div className="space-y-4" data-testid="sysmon-detail-disk" data-disk-id={disk.id}>
      <DetailHeader
        title={`Disk ${index}`}
        subtitle={info?.model ?? disk.id}
        value={disk.available ? `${disk.busyPercent.toFixed(0)}%` : "—"}
      />
      <div className="space-y-1">
        <p className="text-[11px] text-text-subtle">Active time</p>
        <DetailChart maxValue={100} series={[{ data: busy, color: CHART_COLORS.primary }]} height={90} />
      </div>
      <div className="space-y-1">
        <p className="text-[11px] text-text-subtle">Transfer rate</p>
        <DetailChart
          height={90}
          legend={["Read", "Write"]}
          series={[
            { data: read, color: CHART_COLORS.success },
            { data: write, color: CHART_COLORS.secondary },
          ]}
        />
      </div>
      <StatGrid>
        <Stat label="Read speed" value={disk.available ? formatBps(disk.readBps) : undefined} />
        <Stat label="Write speed" value={disk.available ? formatBps(disk.writeBps) : undefined} />
        <Stat label="Avg. response time" value={disk.available ? `${disk.responseMs.toFixed(2)} ms` : undefined} />
        <Stat label="Temperature" value={formatTemp(disk.tempC, tempUnit)} />
        <Stat label="Total read" value={formatBytes(disk.readTotal)} />
        <Stat label="Total written" value={formatBytes(disk.writeTotal)} />
        <Stat label="Capacity" value={info === undefined ? undefined : formatBytes(info.capacityBytes)} />
        <Stat label="Type" value={info === undefined ? undefined : KIND_LABELS[info.kind] ?? info.kind} />
        <Stat label="System disk" value={info === undefined ? undefined : info.systemDisk ? "Yes" : "No"} />
        <Stat label="Removable" value={info === undefined ? undefined : info.removable ? "Yes" : "No"} />
        <Stat label="Rotation" value={info?.rotationRpm === undefined ? undefined : `${info.rotationRpm} RPM`} />
        <Stat label="Serial" value={info?.serial} />
      </StatGrid>
      <PartitionList partitions={info?.partitions ?? []} />
    </div>
  );
}
