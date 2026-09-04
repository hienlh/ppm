import { useMemo } from "react";
import type { MetricsHistoryPoint, SystemMetrics } from "../../../types/system-metrics";
import { CpuCard } from "./overview-cards/cpu-card";
import { MemCard } from "./overview-cards/mem-card";
import { DiskCard } from "./overview-cards/disk-card";
import { NetCard } from "./overview-cards/net-card";
import { GpuCard } from "./overview-cards/gpu-card";

export interface OverviewPanelProps {
  system: SystemMetrics;
  history: MetricsHistoryPoint[];
}

const SERIES_POINTS = 200;

/** One pass over the recent history window building every card's series together,
 *  rather than one `.slice(-200).map(...)` per card. */
function useOverviewSeries(history: MetricsHistoryPoint[]) {
  return useMemo(() => {
    const recent = history.slice(-SERIES_POINTS);
    const cpu: number[] = [];
    const mem: number[] = [];
    const diskRead: number[] = [];
    const diskWrite: number[] = [];
    const netDown: number[] = [];
    const netUp: number[] = [];
    const gpuUtil: number[][] = [];

    for (const point of recent) {
      cpu.push(point.system.cpu.total);
      mem.push(point.system.mem.percent);
      diskRead.push(point.system.disk.available ? point.system.disk.inBps : 0);
      diskWrite.push(point.system.disk.available ? point.system.disk.outBps : 0);
      netDown.push(point.system.net.available ? point.system.net.inBps : 0);
      netUp.push(point.system.net.available ? point.system.net.outBps : 0);
      point.system.gpus.forEach((g, i) => {
        (gpuUtil[i] ??= []).push(g.utilPercent);
      });
    }

    return { cpu, mem, diskRead, diskWrite, netDown, netUp, gpuUtil };
  }, [history]);
}

export function OverviewPanel({ system, history }: OverviewPanelProps) {
  const series = useOverviewSeries(history);
  // Disk/net rates need a delta between two samples — `available:false` on the very
  // first frame(s) is the collector doing exactly what it should, not a missing
  // source, so the card says so instead of the flat, indistinguishable "n/a".
  const measuring = history.length <= 1;

  return (
    <div
      className="p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"
      data-testid="sysmon-overview"
    >
      <CpuCard
        total={system.cpu.total}
        cores={system.cpu.cores}
        model={system.cpu.model}
        series={series.cpu}
      />
      <MemCard
        usedMB={system.mem.usedMB}
        totalMB={system.mem.totalMB}
        percent={system.mem.percent}
        series={series.mem}
      />
      <DiskCard
        available={system.disk.available}
        inBps={system.disk.inBps}
        outBps={system.disk.outBps}
        readSeries={series.diskRead}
        writeSeries={series.diskWrite}
        measuring={measuring}
      />
      <NetCard
        available={system.net.available}
        inBps={system.net.inBps}
        outBps={system.net.outBps}
        downSeries={series.netDown}
        upSeries={series.netUp}
        measuring={measuring}
      />
      {system.gpus.map((gpu, i) => (
        <GpuCard
          key={`${gpu.name}-${i}`}
          name={gpu.name}
          utilPercent={gpu.utilPercent}
          vramUsedMB={gpu.vramUsedMB}
          vramTotalMB={gpu.vramTotalMB}
          series={series.gpuUtil[i] ?? []}
        />
      ))}
    </div>
  );
}
