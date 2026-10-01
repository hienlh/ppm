import { describe, test, expect } from "bun:test";
import {
  buildDeviceList, nicLabel, nicPercent, memoryDetail, resolveSelected,
} from "../../../src/web/components/system/performance/device-list";
import type { SystemMetrics } from "../../../src/types/system-metrics";
import type { HardwareInventory } from "../../../src/types/system-hardware";

const system = (over: Partial<SystemMetrics> = {}): SystemMetrics => ({
  cpu: { total: 12.4, cores: [10, 15], model: "i9-12900K" },
  mem: { totalMB: 64000, usedMB: 21504, availableMB: 42496, percent: 33.6 },
  disk: { inBps: 0, outBps: 0, available: false },
  net: { inBps: 0, outBps: 0, available: false },
  gpus: [],
  processCount: 3,
  ...over,
});

const inventory: HardwareInventory = {
  platform: "linux", ts: 1,
  disks: [{ id: "nvme0n1", model: "TEAM T253X1240G", kind: "nvme", capacityBytes: 1, systemDisk: true, removable: false }],
  nics: [{ id: "enp3s0", kind: "wired", ipv4: [], ipv6: [] }, { id: "wlan0", kind: "wireless", ipv4: [], ipv6: [] }],
  gpus: [],
};

describe("buildDeviceList", () => {
  test("CPU and Memory are always there, in that order", () => {
    const entries = buildDeviceList(system(), null);
    expect(entries.map((e) => e.key)).toEqual(["cpu", "memory"]);
    expect(entries[0]).toMatchObject({ label: "CPU", sublabel: "i9-12900K", detail: "12%", percent: 12.4 });
    expect(entries[1]).toMatchObject({ label: "Memory", sublabel: "21.0/62.5 GB", detail: "34%" });
  });

  test("drives are numbered in order and titled by their model", () => {
    const entries = buildDeviceList(system({
      disks: [
        { id: "nvme0n1", available: true, busyPercent: 7.2, responseMs: 0.3, readBps: 1, writeBps: 2, readTotal: 3, writeTotal: 4 },
        { id: "sda", available: true, busyPercent: 0, responseMs: 0, readBps: 0, writeBps: 0, readTotal: 0, writeTotal: 0 },
      ],
    }), inventory);
    const disks = entries.filter((e) => e.kind === "disk");
    expect(disks.map((d) => d.label)).toEqual(["Disk 0", "Disk 1"]);
    expect(disks[0]?.sublabel).toBe("TEAM T253X1240G");
    // No inventory entry for sda: the kernel name is still better than nothing.
    expect(disks[1]?.sublabel).toBe("sda");
    expect(disks[0]?.detail).toBe("7%");
  });

  test("a device still measuring shows a dash and NO bar, never a confident zero", () => {
    const entries = buildDeviceList(system({
      disks: [{ id: "sda", available: false, busyPercent: 0, responseMs: 0, readBps: 0, writeBps: 0, readTotal: 0, writeTotal: 0 }],
    }), inventory);
    expect(entries[2]).toMatchObject({ detail: "—", percent: null });
  });

  test("interfaces are titled by kind and subtitled by name", () => {
    const entries = buildDeviceList(system({
      nics: [
        { id: "enp3s0", available: true, rxBps: 125000, txBps: 0, rxTotal: 1, txTotal: 2, state: "connected", linkMbps: 1000 },
        { id: "wlan0", available: true, rxBps: 0, txBps: 0, rxTotal: 0, txTotal: 0, state: "disconnected" },
      ],
    }), inventory);
    const nics = entries.filter((e) => e.kind === "nic");
    expect(nics.map((n) => n.label)).toEqual(["Ethernet", "Wi-Fi"]);
    expect(nics[0]?.sublabel).toBe("enp3s0");
    expect(nics[0]?.detail).toBe("122.1 KB/s");
    // 125000 B/s = 1 Mbit/s of a 1000 Mbit/s link.
    expect(nics[0]?.percent).toBeCloseTo(0.1, 5);
    // No link speed: no ceiling, so no bar rather than a guessed one.
    expect(nics[1]?.percent).toBeNull();
  });

  test("GPUs are numbered and keyed by their device id when they have one", () => {
    const entries = buildDeviceList(system({
      gpus: [{ id: "0000:00:02.0", name: "UHD 770", utilPercent: 4, vramUsedMB: 0, vramTotalMB: 0 }],
    }), null);
    expect(entries[2]).toMatchObject({ key: "gpu:0000:00:02.0", label: "GPU 0", sublabel: "UHD 770", detail: "4%" });
  });

  test("a GPU with no device id still gets a stable key", () => {
    const entries = buildDeviceList(system({
      gpus: [{ name: "GTX", utilPercent: 0, vramUsedMB: 0, vramTotalMB: 0 }],
    }), null);
    expect(entries[2]?.key).toBe("gpu:0");
    expect(entries[2]?.id).toBeNull();
  });

  test("fans come last, and only on a host that has any", () => {
    expect(buildDeviceList(system({ fans: [] }), null).some((e) => e.kind === "fans")).toBe(false);
    const entries = buildDeviceList(system({
      fans: [{ id: "a/fan1", label: "CPU", rpm: 900 }, { id: "a/fan2", label: "Rear", rpm: 1400 }],
    }), null);
    const fans = entries[entries.length - 1];
    expect(fans).toMatchObject({ kind: "fans", detail: "1400 RPM", sublabel: "2 sensors", percent: null });
  });

  test("a host that reports no per-device arrays lists only CPU and Memory", () => {
    expect(buildDeviceList(system(), inventory).map((e) => e.kind)).toEqual(["cpu", "memory"]);
  });
});

describe("small helpers", () => {
  test("nicLabel falls back to Other for an interface the inventory does not know", () => {
    expect(nicLabel(undefined)).toBe("Other");
    expect(nicLabel({ id: "tun0", kind: "vpn", ipv4: [], ipv6: [] })).toBe("VPN");
  });

  test("nicPercent is clamped and null without a link speed", () => {
    expect(nicPercent(0, 0, undefined)).toBeNull();
    expect(nicPercent(1, 1, 0)).toBeNull();
    expect(nicPercent(1e9, 0, 100)).toBe(100);
  });

  test("memoryDetail is used over total in GB", () => {
    expect(memoryDetail(1024, 2048)).toBe("1.0/2.0 GB");
  });

  test("resolveSelected keeps a live selection and falls back when it is gone", () => {
    const entries = buildDeviceList(system(), null);
    expect(resolveSelected(entries, "memory")).toBe("memory");
    expect(resolveSelected(entries, "disk:gone")).toBe("cpu");
    expect(resolveSelected([], "anything")).toBe("cpu");
  });
});
