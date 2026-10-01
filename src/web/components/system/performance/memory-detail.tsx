/** Memory page — Mission Center's Memory tab: the usage graph, the composition
 *  strip, and the SMBIOS slot table. The strip has four parts on Linux, which add
 *  up to the total exactly, and three on macOS, which counts no dirty pages. */
import { formatBytes, formatRam } from "@/lib/format-bytes";
import { historySpanLabel } from "@/lib/cpu-graph-mode";
import { CHART_COLORS, CompositionBar, DetailChart, DetailHeader, Stat, StatGrid, useSeries } from "./detail-parts";
import type { MemoryInfo } from "../../../../types/system-hardware";
import type { MemoryMetrics, MetricsHistoryPoint, MetricsPlatform } from "../../../../types/system-metrics";

interface Segment { label: string; value: number; color: string }

export function MemoryDetail({
  mem, info, history, platform,
}: {
  mem: MemoryMetrics;
  info?: MemoryInfo;
  history: readonly MetricsHistoryPoint[];
  platform?: MetricsPlatform;
}) {
  const mac = platform === "darwin";
  const used = useSeries(history, (p) => p.system.mem.percent);
  // Percent of the swap that is in use, so the graph shares the utilisation axis
  // with the memory one above it rather than autoscaling to whatever megabyte
  // figure happens to be the window's maximum.
  const swap = useSeries(history, (p) => {
    const total = p.system.mem.swapTotalMB ?? 0;
    return total > 0 ? ((p.system.mem.swapUsedMB ?? 0) / total) * 100 : 0;
  });
  // In use, standby and free are produced together or not at all, so one of them
  // being present is enough to know the strip can be drawn. Modified exists only
  // where the kernel counts dirty pages, and a part it does not count is left out
  // rather than drawn as 0. macOS's reclaimable part is Activity Monitor's
  // "Cached Files", so it is named that way there.
  const composed = mem.inUseBytes !== undefined;
  const segments = [
    { label: "In use", value: mem.inUseBytes, color: "var(--color-primary)" },
    { label: "Modified", value: mem.modifiedBytes, color: "var(--color-warning)" },
    { label: mac ? "Cached" : "Standby", value: mem.standbyBytes, color: "var(--color-success)" },
    { label: "Free", value: mem.freeBytes, color: "var(--color-border)" },
  ].filter((s): s is Segment => s.value !== undefined);
  const span = historySpanLabel(history.map((p) => p.ts));
  const caption = (what: string) => (span ? `${what} ${span}` : what);
  // A host with swap off gets no swap graph at all: a flat zero line over an
  // axis that does not exist reads as "nothing is swapping", which is a
  // different claim from "there is nowhere to swap to".
  const hasSwap = (mem.swapTotalMB ?? 0) > 0;

  return (
    <div className="space-y-4" data-testid="sysmon-detail-memory">
      <DetailHeader
        title="Memory"
        subtitle={`${formatRam(mem.usedMB)} of ${formatRam(mem.totalMB)} in use`}
        value={`${mem.percent.toFixed(1)}%`}
      />
      <DetailChart
        grid
        maxValue={100}
        caption={caption("Memory usage")}
        ceiling={formatRam(mem.totalMB)}
        series={[{ data: used, color: CHART_COLORS.primary }]}
      />

      {hasSwap && (
        <DetailChart
          grid
          height={90}
          maxValue={100}
          caption={caption("Swap usage")}
          ceiling={formatRam(mem.swapTotalMB ?? 0)}
          series={[{ data: swap, color: CHART_COLORS.success }]}
        />
      )}

      {composed && (
        <div className="space-y-2">
          <CompositionBar segments={segments} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-subtle">
            {segments.map((s) => <span key={s.label}>{s.label} {formatBytes(s.value)}</span>)}
          </div>
        </div>
      )}

      <StatGrid>
        <Stat label="Available" value={formatRam(mem.availableMB)} />
        <Stat label="Cached" value={mem.cachedMB === undefined ? undefined : formatRam(mem.cachedMB)} />
        {/* macOS keeps no commit charge at all: it never promises address space
            against a limit, so there is nothing for the row to be short of. */}
        {!mac && (
          <Stat label="Committed" value={mem.committedMB === undefined ? undefined
            : `${formatRam(mem.committedMB)} / ${mem.commitLimitMB === undefined ? "?" : formatRam(mem.commitLimitMB)}`} />
        )}
        <Stat label="Swap" value={mem.swapTotalMB === undefined ? undefined
          : `${formatRam(mem.swapUsedMB ?? 0)} / ${formatRam(mem.swapTotalMB)}`} />
        {/* macOS's memory compressor is the same idea as zram, built into the
            kernel — the figures mean the same, only the name is Linux's. */}
        <Stat label={mac ? "Compressed" : "Compressed (zram)"} value={mem.zramCompressedMB === undefined ? undefined
          : formatRam(mem.zramCompressedMB)} />
        <Stat label={mac ? "Compression savings" : "Savings (zram)"} value={mem.zramSavingsMB === undefined ? undefined
          : formatRam(mem.zramSavingsMB)} />
        {/* Unified memory sits inside the chip package: no slots to count and no
            capacity to grow into. */}
        {!info?.unified && (
          <>
            <Stat label="Slots used" value={info === undefined ? undefined
              : `${info.devices.length}${info.slotsTotal ? ` of ${info.slotsTotal}` : ""}`} />
            <Stat label="Maximum capacity" value={info?.maxCapacityBytes === undefined ? undefined
              : formatBytes(info.maxCapacityBytes)} />
          </>
        )}
      </StatGrid>

      {info && info.devices.length > 0 && (
        <div className="space-y-1">
          {/* One row that already says "Unified memory" needs no heading. */}
          {!info.unified && <h4 className="text-xs font-medium text-text-secondary">Slots</h4>}
          <div className="rounded-md border border-border divide-y divide-border">
            {info.devices.map((device) => (
              <div key={device.locator} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                <span className="font-medium shrink-0">{device.locator}</span>
                <span className="text-text-subtle truncate">
                  {[device.manufacturer, device.ramType, device.formFactor,
                    device.speedMts ? `${device.speedMts} MT/s` : null].filter(Boolean).join(" · ")}
                </span>
                <span className="tabular-nums shrink-0">{formatBytes(device.sizeBytes)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
