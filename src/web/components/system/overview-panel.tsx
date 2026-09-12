import { useMemo } from "react";
import type { MetricsHistoryPoint, SystemMetrics } from "../../../types/system-metrics";
import { CpuCard } from "./overview-cards/cpu-card";
import { MemCard } from "./overview-cards/mem-card";
import { DiskCard } from "./overview-cards/disk-card";
import { NetCard } from "./overview-cards/net-card";
import { GpuCard } from "./overview-cards/gpu-card";
import { busiestDiskKey, busiestNicKey, gpuKey } from "./overview-device-target";

export interface OverviewPanelProps {
  system: SystemMetrics;
  history: MetricsHistoryPoint[];
  /** Opens the Performance tab on one device. Absent in a read-only render (and
   *  then every card stays a plain frame rather than a button that does nothing). */
  onOpenDevice?: (key: string) => void;
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

export function OverviewPanel({ system, history, onOpenDevice }: OverviewPanelProps) {
  const series = useOverviewSeries(history);
  // Disk/net rates need a delta between two samples — `available:false` on the very
  // first frame(s) is the collector doing exactly what it should, not a missing
  // source, so the card says so instead of the flat, indistinguishable "n/a".
  const measuring = history.length <= 1;
  // Undefined rather than a no-op handler when there is no device to open, so
  // `CardShell` renders a frame instead of a dead button. Computed per render
  // because the busiest drive and interface change with the tick.
  const open = (key: string | null) =>
    onOpenDevice && key ? () => onOpenDevice(key) : undefined;

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
        onOpen={open("cpu")}
      />
      <MemCard
        usedMB={system.mem.usedMB}
        totalMB={system.mem.totalMB}
        percent={system.mem.percent}
        series={series.mem}
        onOpen={open("memory")}
      />
      <DiskCard
        available={system.disk.available}
        inBps={system.disk.inBps}
        outBps={system.disk.outBps}
        readSeries={series.diskRead}
        writeSeries={series.diskWrite}
        measuring={measuring}
        onOpen={open(busiestDiskKey(system))}
      />
      <NetCard
        available={system.net.available}
        inBps={system.net.inBps}
        outBps={system.net.outBps}
        downSeries={series.netDown}
        upSeries={series.netUp}
        measuring={measuring}
        onOpen={open(busiestNicKey(system))}
      />
      {system.gpus.map((gpu, i) => (
        <GpuCard
          key={`${gpu.name}-${i}`}
          name={gpu.name}
          utilPercent={gpu.utilPercent}
          vramUsedMB={gpu.vramUsedMB}
          vramTotalMB={gpu.vramTotalMB}
          series={series.gpuUtil[i] ?? []}
          onOpen={open(gpuKey(gpu.id, i))}
        />
      ))}
    </div>
  );
}
