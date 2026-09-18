/**
 * The Performance page — Mission Center's device sidebar plus one detail page.
 *
 * Two presentations from one tree: at `md` and above the sidebar and the detail
 * sit side by side; below it the sidebar IS the page and tapping a device drills
 * into it, because a 200px sidebar beside a detail grid on a phone leaves neither
 * of them usable.
 */
import { useMemo, type ComponentType } from "react";
import { Activity, ChevronLeft, ChevronRight, Cpu, HardDrive, Layers, Monitor, Wifi } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { buildDeviceList, resolveSelected, type DeviceEntry, type DeviceKind } from "./device-list";
import { useHardwareInventory } from "./use-hardware-inventory";
import { CpuDetail } from "./cpu-detail";
import { MemoryDetail } from "./memory-detail";
import { DiskDetail } from "./disk-detail";
import { NicDetail } from "./nic-detail";
import { GpuDetail } from "./gpu-detail";
import { FansDetail } from "./fans-detail";
import type { HardwareInventory } from "../../../../types/system-hardware";
import type { MetricsHistoryPoint, SystemMetrics } from "../../../../types/system-metrics";

const KIND_ICONS: Record<DeviceKind, ComponentType<{ className?: string }>> = {
  cpu: Cpu, memory: Layers, disk: HardDrive, nic: Wifi, gpu: Monitor, fans: Activity,
};

function barColor(percent: number): string {
  if (percent > 80) return "bg-error";
  if (percent > 50) return "bg-warning";
  return "bg-primary";
}

function DeviceRow({
  entry, selected, showChevron, onSelect,
}: { entry: DeviceEntry; selected: boolean; showChevron: boolean; onSelect: (key: string) => void }) {
  const Icon = KIND_ICONS[entry.kind];
  return (
    <button
      type="button"
      onClick={() => onSelect(entry.key)}
      aria-current={selected}
      data-testid="sysmon-device-row"
      data-device-key={entry.key}
      className={cn(
        "w-full min-h-11 px-3 py-2 flex items-center gap-3 text-left transition-colors",
        selected ? "bg-primary/10 text-text-primary" : "hover:bg-surface-hover",
      )}
    >
      <Icon className="size-4 shrink-0 text-text-subtle" />
      <span className="flex-1 min-w-0">
        <span className="block text-sm truncate">{entry.label}</span>
        <span className="block text-[11px] text-text-subtle truncate" title={entry.sublabel}>
          {entry.sublabel}
        </span>
        {/* No bar at all when the device has no percentage — an empty track would
            read as "measured, and it is zero". */}
        {entry.percent !== null && (
          <span className="mt-1 block h-1 w-full rounded-full bg-surface-hover overflow-hidden">
            <span
              className={cn("block h-full transition-[width]", barColor(entry.percent))}
              style={{ width: `${Math.max(1, Math.min(100, entry.percent))}%` }}
            />
          </span>
        )}
      </span>
      <span className="text-xs tabular-nums text-text-secondary shrink-0">{entry.detail}</span>
      {showChevron && <ChevronRight className="size-4 shrink-0 text-text-subtle" />}
    </button>
  );
}

function DeviceDetail({
  entry, system, inventory, history,
}: {
  entry: DeviceEntry;
  system: SystemMetrics;
  inventory: HardwareInventory | null;
  history: readonly MetricsHistoryPoint[];
}) {
  switch (entry.kind) {
    case "cpu":
      return <CpuDetail cpu={system.cpu} info={inventory?.cpu} history={history} processCount={system.processCount} />;
    case "memory":
      return <MemoryDetail mem={system.mem} info={inventory?.memory} history={history} />;
    case "disk": {
      const index = (system.disks ?? []).findIndex((d) => d.id === entry.id);
      const disk = index >= 0 ? system.disks?.[index] : undefined;
      if (!disk) return null;
      return (
        <DiskDetail
          disk={disk}
          index={index}
          info={inventory?.disks.find((d) => d.id === disk.id)}
          history={history}
        />
      );
    }
    case "nic": {
      const nic = (system.nics ?? []).find((n) => n.id === entry.id);
      if (!nic) return null;
      return <NicDetail nic={nic} info={inventory?.nics.find((n) => n.id === nic.id)} history={history} />;
    }
    case "gpu": {
      const index = system.gpus.findIndex((g) => (entry.id ? g.id === entry.id : true));
      const gpu = index >= 0 ? system.gpus[index] : undefined;
      if (!gpu) return null;
      return (
        <GpuDetail
          gpu={gpu}
          index={index}
          info={inventory?.gpus.find((g) => g.id === gpu.id)}
          history={history}
        />
      );
    }
    case "fans":
      return <FansDetail fans={system.fans ?? []} />;
    default:
      return null;
  }
}

export interface PerformancePanelProps {
  system: SystemMetrics;
  history: MetricsHistoryPoint[];
  /** Selected device key, owned by the parent so an Overview card can jump
   *  straight to one. `null` means "nothing chosen": the desktop sidebar then
   *  falls back to the first entry and the phone shows the device list. */
  device: string | null;
  onDeviceChange: (key: string | null) => void;
}

export function PerformancePanel({
  system, history, device, onDeviceChange,
}: PerformancePanelProps) {
  const isMobile = useIsMobile();

  // Derived from the tick rather than from the device list, so the inventory
  // fetch does not depend on the list that depends on the inventory.
  const deviceIds = useMemo(
    () => [
      ...(system.disks ?? []).map((d) => d.id),
      ...(system.nics ?? []).map((n) => n.id),
      ...system.gpus.map((g) => g.id).filter((id): id is string => !!id),
    ].join(","),
    [system.disks, system.nics, system.gpus],
  );
  const inventory = useHardwareInventory(deviceIds);
  const entries = useMemo(() => buildDeviceList(system, inventory), [system, inventory]);

  // A device that disappears (a drive unplugged) falls back rather than leaving
  // the page blank.
  const selectedKey = resolveSelected(entries, device);
  const selected = entries.find((e) => e.key === selectedKey);

  const list = (
    <div className="divide-y divide-border" role="list" data-testid="sysmon-device-list">
      {entries.map((entry) => (
        <DeviceRow
          key={entry.key}
          entry={entry}
          selected={!isMobile && entry.key === selectedKey}
          showChevron={isMobile}
          onSelect={onDeviceChange}
        />
      ))}
    </div>
  );

  if (isMobile) {
    // The phone shows one thing at a time, so a key that resolves to something
    // OTHER than what was asked for goes back to the list rather than drilling
    // into the fallback. On desktop that fallback is harmless — the sidebar is on
    // screen saying which device is current — and here there is nothing to say it.
    if (device === null || !selected || selectedKey !== device) {
      return <div className="h-full overflow-y-auto" data-testid="sysmon-performance">{list}</div>;
    }
    return (
      <div className="h-full flex flex-col" data-testid="sysmon-performance">
        <button
          type="button"
          onClick={() => onDeviceChange(null)}
          className="shrink-0 min-h-11 px-3 flex items-center gap-2 text-sm border-b border-border"
        >
          <ChevronLeft className="size-4" />
          Devices
        </button>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 @container">
          <DeviceDetail entry={selected} system={system} inventory={inventory} history={history} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex min-h-0" data-testid="sysmon-performance">
      <div className="w-56 shrink-0 border-r border-border overflow-y-auto">{list}</div>
      <div className="flex-1 min-w-0 overflow-y-auto p-4 @container">
        {selected && (
          <DeviceDetail entry={selected} system={system} inventory={inventory} history={history} />
        )}
      </div>
    </div>
  );
}
