/** One GPU — Mission Center's GPU page: three graphs (utilisation, video
 *  encode/decode, memory usage) over the driver's static facts. Every row here is
 *  optional in the contract: a driver that publishes no clock or no power reports
 *  nothing rather than zero, so the row shows an em dash. */
import { formatRam } from "@/lib/format-bytes";
import { historySpanLabel } from "@/lib/cpu-graph-mode";
import { formatTemp } from "@/lib/temperature";
import { useSettingsStore } from "@/stores/settings-store";
import { CHART_COLORS, DetailChart, DetailHeader, Stat, StatGrid, useSeries } from "./detail-parts";
import type { GpuInfo } from "../../../../types/system-metrics";
import type { GpuMetrics, MetricsHistoryPoint, MetricsPlatform } from "../../../../types/system-metrics";

function pcie(gen: number | undefined, lanes: number | undefined): string | undefined {
  if (gen === undefined && lanes === undefined) return undefined;
  return `${gen === undefined ? "?" : `Gen ${gen}`} x${lanes ?? "?"}`;
}

export function GpuDetail({
  gpu, info, index, history, platform,
}: {
  gpu: GpuMetrics; info?: GpuInfo; index: number; history: readonly MetricsHistoryPoint[]; platform?: MetricsPlatform;
}) {
  const tempUnit = useSettingsStore((s) => s.sysmonTempUnit);
  // A Mac's GPU has no media-engine counters, no memory clock of its own, no PCI
  // address on Apple Silicon, and no OpenGL or Vulkan version worth stating (OpenGL
  // is frozen at 4.1, Vulkan is not native): those rows are left out, and the two
  // facts macOS does state — core count and Metal — take their place.
  const mac = platform === "darwin";
  const pick = (p: MetricsHistoryPoint) =>
    p.system.gpus.find((g) => (gpu.id ? g.id === gpu.id : g.name === gpu.name));
  const util = useSeries(history, (p) => pick(p)?.utilPercent);
  const encode = useSeries(history, (p) => pick(p)?.encodePercent);
  const decode = useSeries(history, (p) => pick(p)?.decodePercent);
  // Dedicated memory where the card has some, its share of system RAM where it
  // does not — the two are never both drawn, because they are the same graph
  // answering "how much memory is this GPU using" from whichever source exists.
  const hasVram = gpu.vramTotalMB > 0;
  const hasShared = !hasVram && gpu.sharedTotalMB !== undefined;
  const memory = useSeries(history, (p) => {
    const g = pick(p);
    return hasVram ? g?.vramUsedMB : g?.sharedUsedMB;
  });
  const memoryTotalMB = hasVram ? gpu.vramTotalMB : gpu.sharedTotalMB ?? 0;

  const hasVideo = gpu.encodePercent !== undefined || gpu.decodePercent !== undefined;
  // Intel runs one engine for both directions, so there is one series with the
  // combined label rather than a decode line that would always trace the encode.
  const videoShared = info?.encodeDecodeShared === true;
  const span = historySpanLabel(history.map((p) => p.ts));
  const caption = (what: string) => (span ? `${what} ${span}` : what);

  return (
    <div className="space-y-4" data-testid="sysmon-detail-gpu" data-gpu-id={gpu.id ?? index}>
      <DetailHeader title={`GPU ${index}`} subtitle={gpu.name} value={`${gpu.utilPercent.toFixed(0)}%`} />

      <DetailChart
        grid
        maxValue={100}
        caption={caption("Utilisation")}
        ceiling="100%"
        series={[{ data: util, color: CHART_COLORS.primary }]}
      />

      {hasVideo && (
        <DetailChart
          grid
          height={90}
          maxValue={100}
          caption={caption(videoShared ? "Video encode/decode utilisation" : "Video encode and decode utilisation")}
          ceiling="100%"
          legend={videoShared ? undefined : ["Encode", "Decode"]}
          series={videoShared
            ? [{ data: encode, color: CHART_COLORS.secondary }]
            : [
              { data: encode, color: CHART_COLORS.secondary },
              { data: decode, color: CHART_COLORS.error },
            ]}
        />
      )}

      {(hasVram || hasShared) && (
        <DetailChart
          grid
          height={90}
          maxValue={memoryTotalMB}
          caption={caption(hasVram ? "Video memory usage" : "Memory usage")}
          ceiling={formatRam(memoryTotalMB)}
          series={[{ data: memory, color: CHART_COLORS.success }]}
        />
      )}

      <StatGrid>
        {(!mac || hasVram) && (
          <Stat label="Video memory" value={hasVram
            ? `${formatRam(gpu.vramUsedMB)} / ${formatRam(gpu.vramTotalMB)}` : undefined} />
        )}
        <Stat label={hasVram ? "Shared memory" : "Memory usage"} value={gpu.sharedTotalMB === undefined ? undefined
          : `${formatRam(gpu.sharedUsedMB ?? 0)} / ${formatRam(gpu.sharedTotalMB)}`} />
        {!mac && (
          <Stat
            label={videoShared ? "Video encode/decode" : "Video encode"}
            value={gpu.encodePercent === undefined ? undefined : `${gpu.encodePercent.toFixed(0)}%`}
          />
        )}
        {!mac && !videoShared && (
          <Stat label="Video decode" value={gpu.decodePercent === undefined ? undefined
            : `${gpu.decodePercent.toFixed(0)}%`} />
        )}
        <Stat label="Clock" value={gpu.clockMHz === undefined ? undefined
          : `${gpu.clockMHz} MHz${gpu.clockMaxMHz ? ` / ${gpu.clockMaxMHz}` : ""}`} />
        {!mac && (
          <Stat label="Memory clock" value={gpu.memClockMHz === undefined ? undefined
            : `${gpu.memClockMHz} MHz${gpu.memClockMaxMHz ? ` / ${gpu.memClockMaxMHz}` : ""}`} />
        )}
        <Stat label="Power" value={gpu.powerW === undefined ? undefined
          : `${gpu.powerW.toFixed(1)} W${gpu.powerMaxW ? ` / ${gpu.powerMaxW}` : ""}`} />
        <Stat label="Temperature" value={formatTemp(gpu.tempC, tempUnit)} />
        {mac && <Stat label="GPU cores" value={info?.coreCount?.toString()} />}
        <Stat label="Vendor" value={info?.vendor} />
        <Stat label="Driver" value={info?.driver === undefined ? undefined
          : [info.driver, info.driverVersion].filter(Boolean).join(" ")} />
        {mac && <Stat label="Metal" value={info?.metalVersion} />}
        {!mac && (
          <>
            <Stat label="OpenGL" value={info?.openglVersion} />
            <Stat label="Vulkan" value={info?.vulkanVersion} />
            <Stat label="PCI bus address" value={gpu.id} />
            <Stat label="PCIe link" value={pcie(info?.pcieGen, info?.pcieLanes)} />
            <Stat label="PCIe maximum" value={pcie(info?.pcieMaxGen, info?.pcieMaxLanes)} />
          </>
        )}
      </StatGrid>
    </div>
  );
}
