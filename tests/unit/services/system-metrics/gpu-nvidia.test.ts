import { describe, test, expect } from "bun:test";
import {
  parseNvidiaSmiCsv,
  createNvidiaGpuCollector,
  NVIDIA_SMI_ARGV,
} from "../../../../src/services/system-metrics/gpu-collector-nvidia.ts";
import type { Runner, RunResult } from "../../../../src/services/host-info/spawn-runner.ts";

const okRun = (stdout: string): RunResult => ({ stdout, stderr: "", code: 0, timedOut: false });

describe("parseNvidiaSmiCsv", () => {
  test("parses the csv,noheader,nounits row captured on this host", () => {
    expect(parseNvidiaSmiCsv("NVIDIA GeForce RTX 4070, 0, 846, 12282\n")).toEqual([
      { name: "NVIDIA GeForce RTX 4070", utilPercent: 0, vramUsedMB: 846, vramTotalMB: 12282 },
    ]);
  });

  test("[N/A] fields become 0, not NaN; util is clamped", () => {
    const [gpu] = parseNvidiaSmiCsv("Some GPU, [N/A], [N/A], 4096");
    expect(gpu).toEqual({ name: "Some GPU", utilPercent: 0, vramUsedMB: 0, vramTotalMB: 4096 });
    expect(parseNvidiaSmiCsv("X, 250, 1, 2")[0]!.utilPercent).toBe(100);
  });

  test("multiple GPUs and garbage rows", () => {
    const rows = parseNvidiaSmiCsv("A, 10, 1, 2\n\nnot,enough\nB, 20, 3, 4\n");
    expect(rows.map((g) => g.name)).toEqual(["A", "B"]);
  });
});

describe("createNvidiaGpuCollector", () => {
  test("spawns one-shot per collect with the fixed argv", async () => {
    const calls: string[][] = [];
    const run: Runner = async (argv) => { calls.push(argv); return okRun("A, 1, 2, 3"); };
    const c = createNvidiaGpuCollector(run);
    expect(await c.collect()).toHaveLength(1);
    expect(await c.collect()).toHaveLength(1);
    expect(calls).toEqual([NVIDIA_SMI_ARGV, NVIDIA_SMI_ARGV]);
  });

  test("a missing binary (spawn throws) disables the collector after repeated failures — a machine does not grow a GPU", async () => {
    let calls = 0;
    const run: Runner = async () => { calls++; throw new Error("ENOENT"); };
    const c = createNvidiaGpuCollector(run);
    for (let i = 0; i < 10; i++) expect(await c.collect()).toEqual([]);
    expect(c.isDisabled()).toBe(true);
    expect(calls).toBe(3);
  });

  test("a transient non-zero exit returns [] and resets the failure streak on success", async () => {
    let n = 0;
    const run: Runner = async () => (n++ % 2 === 0 ? { stdout: "", stderr: "busy", code: 1, timedOut: false } : okRun("A, 1, 2, 3"));
    const c = createNvidiaGpuCollector(run);
    for (let i = 0; i < 8; i++) await c.collect();
    expect(c.isDisabled()).toBe(false);
  });
});
