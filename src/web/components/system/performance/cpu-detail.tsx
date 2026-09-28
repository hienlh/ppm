/**
 * CPU page — Mission Center's CPU tab.
 *
 * Two graphs, both of which the right-click menu re-points: the top one between
 * overall utilisation, a grid of one graph per logical processor, and every
 * thread overlaid or stacked; the bottom one between temperature, package power,
 * clock speed and nothing at all. The menu is the feature — an i9's eight P-cores
 * and eight E-cores behave nothing alike, and one averaged line hides that.
 */
import { useMemo } from "react";
import { formatBytes } from "@/lib/format-bytes";
import { formatTemp } from "@/lib/temperature";
import { useSettingsStore } from "@/stores/settings-store";
import {
  CPU_BOTTOM_GRAPHS, CPU_BOTTOM_LABELS, CPU_GRAPH_LABELS, CPU_GRAPH_MODES, historySpanLabel,
} from "@/lib/cpu-graph-mode";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuRadioGroup, ContextMenuRadioItem,
  ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { CpuCoreGrid } from "./cpu-core-grid";
import { CHART_COLORS, DetailChart, DetailHeader, Stat, StatGrid, useSeries } from "./detail-parts";
import type { CpuInfo } from "../../../../types/system-hardware";
import type { CpuMetrics, MetricsHistoryPoint } from "../../../../types/system-metrics";

function uptime(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

const GHZ = (mhz: number | undefined) => (mhz === undefined ? undefined : `${(mhz / 1000).toFixed(2)} GHz`);

export function CpuDetail({
  cpu, info, history, processCount,
}: {
  cpu: CpuMetrics;
  info?: CpuInfo;
  history: readonly MetricsHistoryPoint[];
  processCount?: number;
}) {
  const tempUnit = useSettingsStore((s) => s.sysmonTempUnit);
  const kernelTimes = useSettingsStore((s) => s.sysmonKernelTimes);
  const setKernelTimes = useSettingsStore((s) => s.setSysmonKernelTimes);
  const mode = useSettingsStore((s) => s.sysmonCpuGraph);
  const setMode = useSettingsStore((s) => s.setSysmonCpuGraph);
  const bottom = useSettingsStore((s) => s.sysmonCpuBottomGraph);
  const setBottom = useSettingsStore((s) => s.setSysmonCpuBottomGraph);

  const total = useSeries(history, (p) => p.system.cpu.total);
  const kernel = useSeries(history, (p) => p.system.cpu.kernelPercent);
  const tempSeries = useSeries(history, (p) => p.system.cpu.tempC);
  const powerSeries = useSeries(history, (p) => p.system.cpu.powerW);
  const clockSeries = useSeries(history, (p) => p.system.cpu.currentMHz);

  // The kernel line is a SUBSET of the total and is only drawn where the host
  // reports it — otherwise a flat zero line would read as "no kernel time". The
  // preference can only take it away, never conjure one the host never sent.
  const hasKernel = kernelTimes && cpu.kernelPercent !== undefined;
  const span = historySpanLabel(history.map((p) => p.ts));
  const caption = (what: string) => (span ? `${what} ${span}` : what);

  // One pass over the window for every thread at once, shared by the overlaid and
  // the stacked mode. Stacked divides by the thread count so the stack's top edge
  // is the machine's overall utilisation rather than 2400%.
  const threads = useMemo(() => {
    const window = history.slice(-200);
    const n = cpu.cores.length;
    const out: number[][] = Array.from({ length: n }, () => []);
    for (const point of window) {
      const values = point.system.cpu.cores;
      for (let i = 0; i < n; i++) out[i]!.push(values[i] ?? 0);
    }
    return out;
  }, [history, cpu.cores.length]);

  const threadSeries = threads.map((data) => ({ data, color: CHART_COLORS.primary }));
  const stackedSeries = threads.map((data) => ({
    data: data.map((v) => v / Math.max(1, threads.length)),
    color: CHART_COLORS.primary,
  }));

  const bottomChart = () => {
    if (bottom === "none") return null;
    if (bottom === "temperature") {
      if (cpu.tempC === undefined) return null;
      return (
        <DetailChart
          grid
          height={100}
          caption={caption("Temperature")}
          ceiling={formatTemp(Math.max(...tempSeries, 1), tempUnit)}
          series={[{ data: tempSeries, color: CHART_COLORS.error }]}
        />
      );
    }
    if (bottom === "power") {
      if (cpu.powerW === undefined) return null;
      return (
        <DetailChart
          grid
          height={100}
          caption={caption("Power draw")}
          ceiling={`${Math.max(...powerSeries, 1).toFixed(1)} W`}
          series={[{ data: powerSeries, color: CHART_COLORS.secondary }]}
        />
      );
    }
    if (cpu.currentMHz === undefined) return null;
    return (
      <DetailChart
        grid
        height={100}
        caption={caption("Clock speed")}
        ceiling={GHZ(info?.maxMHz ?? Math.max(...clockSeries, 1))}
        maxValue={info?.maxMHz}
        series={[{ data: clockSeries, color: CHART_COLORS.success }]}
      />
    );
  };

  return (
    <div className="space-y-4" data-testid="sysmon-detail-cpu">
      <DetailHeader title="CPU" subtitle={info?.name ?? cpu.model} value={`${cpu.total.toFixed(1)}%`} />

      <ContextMenu>
        <ContextMenuTrigger>
          <div className="space-y-3 select-none" data-testid="sysmon-cpu-graphs">
            {mode === "logical" ? (
              <div className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-[11px] text-text-subtle">
                  <span className="truncate">{caption("Utilisation")}</span>
                  <span className="shrink-0 tabular-nums">100%</span>
                </div>
                <CpuCoreGrid cores={cpu.cores} history={history} />
              </div>
            ) : (
              <DetailChart
                grid
                maxValue={100}
                caption={caption("Utilisation")}
                ceiling="100%"
                stacked={mode === "threads-stacked"}
                legend={mode === "overall" && hasKernel ? ["Utilisation", "Kernel"] : undefined}
                series={
                  mode === "threads" ? threadSeries
                  : mode === "threads-stacked" ? stackedSeries
                  : hasKernel
                    ? [{ data: total, color: CHART_COLORS.primary }, { data: kernel, color: CHART_COLORS.secondary }]
                    : [{ data: total, color: CHART_COLORS.primary }]
                }
              />
            )}
            {bottomChart()}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Change top graph to</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                {CPU_GRAPH_MODES.map((m) => (
                  <ContextMenuRadioItem key={m} value={m} data-testid={`sysmon-cpu-graph-${m}`}>
                    {CPU_GRAPH_LABELS[m]}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Change bottom graph to</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup value={bottom} onValueChange={(v) => setBottom(v as typeof bottom)}>
                {CPU_BOTTOM_GRAPHS.map((m) => (
                  <ContextMenuRadioItem key={m} value={m} data-testid={`sysmon-cpu-bottom-${m}`}>
                    {CPU_BOTTOM_LABELS[m]}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          {/* A plain item rather than a checkbox one: the same switch is in
              Preferences, and this is the place Mission Center puts it. */}
          <ContextMenuItem
            onSelect={() => setKernelTimes(!kernelTimes)}
            data-testid="sysmon-cpu-kernel-toggle"
          >
            {kernelTimes ? "Hide kernel times" : "Show kernel times"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <StatGrid>
        <Stat label="Speed" value={GHZ(cpu.currentMHz)} />
        <Stat label="Base speed" value={GHZ(info?.baseMHz)} />
        <Stat label="Max speed" value={GHZ(info?.maxMHz)} />
        <Stat label="Temperature" value={formatTemp(cpu.tempC, tempUnit)} />
        <Stat label="Power" value={cpu.powerW === undefined ? undefined : `${cpu.powerW.toFixed(1)} W`} />
        <Stat label="Processes" value={processCount} />
        <Stat label="Threads running" value={cpu.threadCount} />
        <Stat label="Open handles" value={cpu.handleCount} />
        <Stat label="Up time" value={uptime(cpu.uptimeSec)} />
        <Stat label="Sockets" value={info?.sockets} />
        <Stat label="Cores" value={info?.physicalCores} />
        <Stat label="Logical processors" value={info?.logicalCores ?? cpu.cores.length} />
        <Stat label="Virtualisation" value={info?.isVirtualMachine ? "Running in a VM" : info?.virtualization} />
        <Stat label="L1 cache" value={info?.l1CacheBytes === undefined ? undefined : formatBytes(info.l1CacheBytes)} />
        <Stat label="L2 cache" value={info?.l2CacheBytes === undefined ? undefined : formatBytes(info.l2CacheBytes)} />
        <Stat label="L3 cache" value={info?.l3CacheBytes === undefined ? undefined : formatBytes(info.l3CacheBytes)} />
        <Stat label="Cpufreq driver" value={info?.freqDriver} />
        <Stat label="Governor" value={info?.freqGovernor} />
        <Stat label="Power preference" value={info?.powerPreference} />
      </StatGrid>
    </div>
  );
}
