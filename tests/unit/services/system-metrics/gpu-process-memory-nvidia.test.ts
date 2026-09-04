import { describe, test, expect } from "bun:test";
import {
  parseComputeAppsCsv,
  createNvidiaProcessMemoryCollector,
  NVIDIA_COMPUTE_APPS_ARGV,
} from "../../../../src/services/system-metrics/gpu-process-memory-nvidia.ts";
import type { RunResult } from "../../../../src/services/host-info/spawn-runner.ts";

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", code: 0, timedOut: false });
const fail = (): RunResult => ({ stdout: "", stderr: "not found", code: 127, timedOut: false });

describe("parseComputeAppsCsv", () => {
  test("pid, used MB per row", () => {
    const m = parseComputeAppsCsv("1234, 512\n5678, 1024\n");
    expect(m.get(1234)).toBe(512);
    expect(m.get(5678)).toBe(1024);
  });

  test("the same pid on two GPUs is summed", () => {
    expect(parseComputeAppsCsv("1234, 512\n1234, 256\n").get(1234)).toBe(768);
  });

  test("a real pid with an unsupported figure contributes 0, not NaN; junk rows are dropped", () => {
    const m = parseComputeAppsCsv("1234, [N/A]\n1234, [Not Supported]\nno-pid, 5\n0, 5\n\n");
    expect(m.get(1234)).toBe(0);
    expect(m.size).toBe(1);
  });
});

describe("createNvidiaProcessMemoryCollector", () => {
  test("queries pid + used_memory unit-less, and returns the map", async () => {
    const calls: string[][] = [];
    const c = createNvidiaProcessMemoryCollector(async (argv) => {
      calls.push(argv);
      return ok("42, 128\n");
    });
    expect((await c.collect())!.get(42)).toBe(128);
    expect(calls[0]).toEqual(NVIDIA_COMPUTE_APPS_ARGV);
    expect(NVIDIA_COMPUTE_APPS_ARGV.join(" ")).toContain("--query-compute-apps=pid,used_memory");
  });

  test("a failure returns null (so the column stays unmeasured) and gives up after three tries", async () => {
    let calls = 0;
    const c = createNvidiaProcessMemoryCollector(async () => {
      calls++;
      return fail();
    });
    expect(await c.collect()).toBeNull();
    expect(await c.collect()).toBeNull();
    expect(await c.collect()).toBeNull();
    expect(c.isDisabled()).toBe(true);
    expect(await c.collect()).toBeNull();
    expect(calls).toBe(3); // the fourth call does not spawn
  });

  test("a thrown spawn (no binary at all) is caught", async () => {
    const c = createNvidiaProcessMemoryCollector(async () => {
      throw new Error("ENOENT");
    });
    expect(await c.collect()).toBeNull();
  });
});
