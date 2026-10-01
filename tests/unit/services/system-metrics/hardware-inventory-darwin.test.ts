/** The inventory's darwin branch: CPU from sysctl with the power manager's top
 *  clock, memory from system_profiler, drives and interfaces from the shared tool
 *  reads — each absent when its source is. */
import { describe, expect, test } from "bun:test";
import { readHardwareInventory, type DarwinInventorySources } from "../../../../src/services/system-metrics/hardware-inventory.ts";
import { parsePmgrDvfs } from "../../../../src/services/system-metrics/cpu-details-darwin.ts";
import { parseSpMemory } from "../../../../src/services/system-metrics/memory-darwin.ts";
import type { GpuApiVersionReader } from "../../../../src/services/system-metrics/gpu-api-versions.ts";
import { darwinFixture, fakeKernel } from "./fixtures/darwin-fixture.ts";

const noApi = { read: async () => ({}) } as unknown as GpuApiVersionReader;

const sources = (over: Partial<DarwinInventorySources> = {}): DarwinInventorySources => ({
  kernel: () => fakeKernel(darwinFixture("sysctl-m1max.txt")),
  dvfs: async () => parsePmgrDvfs(darwinFixture("ioreg-pmgr.xml")),
  memory: async () => parseSpMemory(darwinFixture("sp-memory-apple-silicon.json")),
  disks: async () => [{ id: "disk0", kind: "nvme", capacityBytes: 1, systemDisk: true, removable: false }],
  nics: async () => [{ id: "en0", kind: "wireless", ipv4: [], ipv6: [] }],
  gpus: async () => [{ id: "agxg13x-0", name: "Apple M1 Max", vendor: "Apple", coreCount: 32, metalVersion: "Metal 3" }],
  ...over,
});

describe("readHardwareInventory on darwin", () => {
  test("CPU and memory, with the top clock from the power manager", async () => {
    const inv = await readHardwareInventory("darwin", () => 1234, noApi, sources());
    expect(inv.platform).toBe("darwin");
    expect(inv.ts).toBe(1234);
    expect(inv.cpu).toMatchObject({ name: "Apple M1 Max", performanceCores: 8, efficiencyCores: 2, maxMHz: 3228 });
    expect(inv.memory?.unified).toBe(true);
    expect(inv.memory?.devices[0]?.ramType).toBe("LPDDR5");
  });

  test("drives, interfaces and GPUs, so the tick's device ids are ones the client can name", async () => {
    const inv = await readHardwareInventory("darwin", () => 1, noApi, sources());
    expect(inv.disks.map((d) => d.id)).toEqual(["disk0"]);
    expect(inv.nics.map((n) => n.id)).toEqual(["en0"]);
    expect(inv.gpus.map((g) => g.id)).toEqual(["agxg13x-0"]);
  });

  test("no frequency tables is a CPU without a top clock, not a missing CPU", async () => {
    const inv = await readHardwareInventory("darwin", Date.now, noApi, sources({ dvfs: async () => undefined }));
    expect(inv.cpu?.name).toBe("Apple M1 Max");
    expect(inv.cpu?.maxMHz).toBeUndefined();
  });

  test("a source that did not answer leaves its section out", async () => {
    const inv = await readHardwareInventory("darwin", Date.now, noApi, sources({
      kernel: () => null, memory: async () => undefined, disks: async () => [], nics: async () => [], gpus: async () => [],
    }));
    expect("cpu" in inv).toBe(false);
    expect("memory" in inv).toBe(false);
    expect(inv.disks).toEqual([]);
    expect(inv.nics).toEqual([]);
    expect(inv.gpus).toEqual([]);
  });

  test("Windows still reports the empty base", async () => {
    const inv = await readHardwareInventory("win32", () => 1, noApi, sources());
    expect(inv).toEqual({ platform: "win32", ts: 1, disks: [], nics: [], gpus: [] });
  });
});
