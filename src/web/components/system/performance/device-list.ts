/**
 * The Performance page's device sidebar, as data - Mission Center's left column.
 *
 * Pure and React-free so the labelling and the summary figures are unit-tested
 * without mounting anything. Imports are relative rather than through the "@"
 * alias for the same reason: everything under `@/` risks reaching a zustand store,
 * which reads localStorage at module scope and throws under bun:test.
 */
import type { HardwareInventory, NicInfo, NicKind } from "../../../../types/system-hardware";
import type { SystemMetrics } from "../../../../types/system-metrics";
import { formatBps } from "../../../lib/format-bytes";

export type DeviceKind = "cpu" | "memory" | "disk" | "nic" | "gpu" | "fans";

export interface DeviceEntry {
  /** Stable across ticks: the selection key and the React key. */
  key: string;
  kind: DeviceKind;
  /** Sidebar title: "CPU", "Disk 0", "Ethernet". */
  label: string;
  /** Second line: the model or interface name. Empty when there is nothing to add. */
  sublabel: string;
  /** The metrics id this entry is keyed by (disk/nic/gpu), else null. */
  id: string | null;
  /** Right-hand summary: "12%", "21.0/62.5 GB", "1.2 MB/s". */
  detail: string;
  /** 0-100 for the row's mini bar. Null when the device has no percentage to show,
   *  which must render as no bar rather than as an empty one. */
  percent: number | null;
}

/** Mission Center's interface names, in its own wording. */
export const NIC_KIND_LABELS: Record<NicKind, string> = {
  wired: "Ethernet",
  wireless: "Wi-Fi",
  bluetooth: "Bluetooth",
  bridge: "Bridge",
  docker: "Docker",
  infiniband: "InfiniBand",
  multipass: "Multipass",
  virtual: "Virtual",
  vpn: "VPN",
  other: "Other",
};

const GB = 1024;
const round = (n: number) => Math.round(n);

export function nicLabel(info: NicInfo | undefined): string {
  return NIC_KIND_LABELS[info?.kind ?? "other"];
}

/**
 * A NIC's bar is its share of the negotiated link speed. Null when the link speed
 * is unknown - a tunnel or a virtual interface has no ceiling to be a share of,
 * and a bar drawn against a guessed one is worse than no bar.
 */
export function nicPercent(rxBps: number, txBps: number, linkMbps: number | undefined): number | null {
  if (!linkMbps || linkMbps <= 0) return null;
  const usedMbps = ((rxBps + txBps) * 8) / 1_000_000;
  return Math.min(100, Math.max(0, (usedMbps / linkMbps) * 100));
}

export function memoryDetail(usedMB: number, totalMB: number): string {
  return `${(usedMB / GB).toFixed(1)}/${(totalMB / GB).toFixed(1)} GB`;
}

/**
 * Every device this host can show, in Mission Center's order: CPU, Memory, then
 * the drives, the interfaces, the GPUs, and fans last.
 *
 * A device the tick did not report is absent rather than listed as zero - the
 * per-device arrays are optional in the contract precisely because a host may not
 * measure them at all.
 */
export function buildDeviceList(system: SystemMetrics, inventory: HardwareInventory | null): DeviceEntry[] {
  const diskInfo = new Map((inventory?.disks ?? []).map((d) => [d.id, d]));
  const nicInfo = new Map((inventory?.nics ?? []).map((n) => [n.id, n]));
  const entries: DeviceEntry[] = [
    {
      key: "cpu", kind: "cpu", label: "CPU", sublabel: system.cpu.model, id: null,
      detail: `${round(system.cpu.total)}%`, percent: system.cpu.total,
    },
    {
      key: "memory", kind: "memory", label: "Memory",
      sublabel: memoryDetail(system.mem.usedMB, system.mem.totalMB), id: null,
      detail: `${round(system.mem.percent)}%`, percent: system.mem.percent,
    },
  ];

  (system.disks ?? []).forEach((disk, index) => {
    entries.push({
      key: `disk:${disk.id}`, kind: "disk", label: `Disk ${index}`,
      sublabel: diskInfo.get(disk.id)?.model ?? disk.id, id: disk.id,
      // "Active time" is the figure Mission Center puts in the sidebar, not
      // throughput: a drive at 100% busy moving very little still matters.
      detail: disk.available ? `${round(disk.busyPercent)}%` : "—",
      percent: disk.available ? disk.busyPercent : null,
    });
  });

  (system.nics ?? []).forEach((nic) => {
    const info = nicInfo.get(nic.id);
    entries.push({
      key: `nic:${nic.id}`, kind: "nic", label: nicLabel(info), sublabel: nic.id, id: nic.id,
      detail: nic.available ? formatBps(nic.rxBps + nic.txBps) : "—",
      percent: nic.available ? nicPercent(nic.rxBps, nic.txBps, nic.linkMbps) : null,
    });
  });

  system.gpus.forEach((gpu, index) => {
    entries.push({
      key: `gpu:${gpu.id ?? index}`, kind: "gpu", label: `GPU ${index}`,
      sublabel: gpu.name, id: gpu.id ?? null,
      detail: `${round(gpu.utilPercent)}%`, percent: gpu.utilPercent,
    });
  });

  const fans = system.fans ?? [];
  if (fans.length > 0) {
    const fastest = Math.max(...fans.map((f) => f.rpm));
    entries.push({
      key: "fans", kind: "fans", label: "Fans",
      sublabel: `${fans.length} sensor${fans.length === 1 ? "" : "s"}`, id: null,
      detail: `${fastest} RPM`, percent: null,
    });
  }

  return entries;
}

/**
 * The entry to show when the previous selection is gone - a USB drive unplugged,
 * an interface removed. Falls back to the CPU, which every host has.
 */
export function resolveSelected(entries: readonly DeviceEntry[], wanted: string | null): string {
  if (wanted && entries.some((e) => e.key === wanted)) return wanted;
  return entries[0]?.key ?? "cpu";
}
