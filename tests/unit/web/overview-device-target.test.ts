/**
 * Which Performance device an Overview card opens.
 *
 * The load-bearing assertion here is not which device wins — it is that the key
 * these functions produce **matches a real entry** from `buildDeviceList`. The
 * two modules agree only by string format (`disk:<id>`, `nic:<id>`, `gpu:<id>`),
 * and a key that matches nothing is silent: `resolveSelected` falls back to the
 * first entry, so a click on the Disk card would quietly open CPU. Every case
 * below therefore resolves its key against a real list rather than comparing it
 * to a literal.
 */
import { describe, test, expect } from "bun:test";
import {
  busiestDiskKey, busiestNicKey, gpuKey,
} from "../../../src/web/components/system/overview-device-target.ts";
import {
  buildDeviceList, resolveSelected,
} from "../../../src/web/components/system/performance/device-list.ts";
import type { SystemMetrics } from "../../../src/types/system-metrics";

function disk(id: string, busyPercent: number, available = true) {
  return {
    id, available, busyPercent, responseMs: 0,
    readBps: 0, writeBps: 0, readTotal: 0, writeTotal: 0,
  };
}

function nic(id: string, rxBps: number, txBps: number, available = true) {
  return {
    id, available, rxBps, txBps, rxTotal: 0, txTotal: 0,
    state: "up" as const, linkMbps: 1000,
  };
}

function metrics(over: Partial<SystemMetrics> = {}): SystemMetrics {
  return {
    cpu: { total: 5, cores: [5], model: "test", kernelPercent: 1, coreKernel: [1] },
    mem: { totalMB: 1000, usedMB: 500, availableMB: 500, percent: 50 },
    disk: { available: true, inBps: 0, outBps: 0 },
    net: { available: true, inBps: 0, outBps: 0 },
    gpus: [],
    processCount: 0,
    ...over,
  } as unknown as SystemMetrics;
}

/** What the panel actually does with the key: land on it, or silently on CPU. */
function landsOn(system: SystemMetrics, key: string | null): string {
  return resolveSelected(buildDeviceList(system, null), key);
}

describe("busiestDiskKey", () => {
  test("picks the drive with the most active time, not the first one", () => {
    // This host's real shape: Disk 0 is an idle Toshiba, Disk 1 is the loaded one.
    const system = metrics({ disks: [disk("sdb", 0), disk("sda", 76)] as never });
    expect(busiestDiskKey(system)).toBe("disk:sda");
    expect(landsOn(system, busiestDiskKey(system))).toBe("disk:sda");
  });

  test("the key it answers is a real sidebar entry, never a silent fallback", () => {
    const system = metrics({ disks: [disk("nvme0n1", 12)] as never });
    const key = busiestDiskKey(system);
    expect(buildDeviceList(system, null).some((e) => e.key === key)).toBe(true);
  });

  test("a host with no drives has nothing to open", () => {
    expect(busiestDiskKey(metrics())).toBeNull();
    expect(busiestDiskKey(metrics({ disks: [] as never }))).toBeNull();
  });

  test("an unmeasurable drive is skipped in favour of a measurable one", () => {
    const system = metrics({ disks: [disk("sda", 99, false), disk("sdb", 3)] as never });
    expect(busiestDiskKey(system)).toBe("disk:sdb");
  });

  test("first tick — every drive unmeasurable — still opens something", () => {
    // `available:false` everywhere is the collector working correctly (a rate
    // needs two samples), so the click has to land somewhere and let the page
    // render its em dashes rather than doing nothing.
    const system = metrics({ disks: [disk("sda", 0, false), disk("sdb", 0, false)] as never });
    expect(busiestDiskKey(system)).toBe("disk:sda");
  });

  test("a wholly idle machine is deterministic — ties go to the first", () => {
    const system = metrics({ disks: [disk("sda", 0), disk("sdb", 0)] as never });
    expect(busiestDiskKey(system)).toBe("disk:sda");
    expect(busiestDiskKey(system)).toBe(busiestDiskKey(system));
  });
});

describe("busiestNicKey", () => {
  test("ranks by rx+tx together, since a card shows both directions", () => {
    const system = metrics({
      nics: [nic("eth0", 100, 0), nic("wg0", 10, 500), nic("lo", 50, 50)] as never,
    });
    expect(busiestNicKey(system)).toBe("nic:wg0");
    expect(landsOn(system, busiestNicKey(system))).toBe("nic:wg0");
  });

  test("raw throughput wins over share of link speed", () => {
    // A 100 Mbit NIC at half capacity is a smaller number on the card than a
    // 10 Gbit one at 5%, and the card is what the reader clicked.
    const slowButSaturated = { ...nic("eth0", 6_000_000, 0), linkMbps: 100 };
    const fastAndBusy = { ...nic("eth1", 60_000_000, 0), linkMbps: 10_000 };
    const system = metrics({ nics: [slowButSaturated, fastAndBusy] as never });
    expect(busiestNicKey(system)).toBe("nic:eth1");
  });

  test("a host with no interfaces has nothing to open", () => {
    expect(busiestNicKey(metrics())).toBeNull();
  });
});

describe("gpuKey", () => {
  test("matches buildDeviceList for a GPU with a PCI address", () => {
    const system = metrics({
      gpus: [{ id: "0000:00:02.0", name: "UHD 770", utilPercent: 9, vramUsedMB: 0, vramTotalMB: 0 }] as never,
    });
    expect(gpuKey("0000:00:02.0", 0)).toBe("gpu:0000:00:02.0");
    expect(landsOn(system, gpuKey("0000:00:02.0", 0))).toBe("gpu:0000:00:02.0");
  });

  test("falls back to the index exactly as the sidebar does", () => {
    const system = metrics({
      gpus: [{ name: "Unknown GPU", utilPercent: 0, vramUsedMB: 0, vramTotalMB: 0 }] as never,
    });
    expect(gpuKey(undefined, 0)).toBe("gpu:0");
    expect(landsOn(system, gpuKey(undefined, 0))).toBe("gpu:0");
  });

  test("the second GPU is not the first — the index is not ignored", () => {
    expect(gpuKey(undefined, 1)).toBe("gpu:1");
  });
});

describe("the two modules cannot drift apart unnoticed", () => {
  test("every card's key resolves to its own entry on a fully-populated host", () => {
    const system = metrics({
      disks: [disk("sda", 5), disk("sdb", 80)] as never,
      nics: [nic("enp3s0", 1000, 2000), nic("tailscale0", 10, 10)] as never,
      gpus: [
        { id: "0000:00:02.0", name: "iGPU", utilPercent: 5, vramUsedMB: 0, vramTotalMB: 0 },
        { id: "0000:01:00.0", name: "dGPU", utilPercent: 50, vramUsedMB: 100, vramTotalMB: 8000 },
      ] as never,
    });
    expect(landsOn(system, "cpu")).toBe("cpu");
    expect(landsOn(system, "memory")).toBe("memory");
    expect(landsOn(system, busiestDiskKey(system))).toBe("disk:sdb");
    expect(landsOn(system, busiestNicKey(system))).toBe("nic:enp3s0");
    expect(landsOn(system, gpuKey("0000:01:00.0", 1))).toBe("gpu:0000:01:00.0");
  });

  test("a key that matches nothing falls back silently — why the above matters", () => {
    // Pinned so the failure mode stays documented: this is NOT an error path.
    const system = metrics({ disks: [disk("sda", 5)] as never });
    expect(landsOn(system, "disk:does-not-exist")).toBe("cpu");
  });
});
