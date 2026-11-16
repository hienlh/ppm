/**
 * `system_resources` and the Windows kernel reads behind it: struct parsing on built buffers, a
 * live read on a Windows host checked for sanity, and the tool's answer, which carries no
 * command line, environment or event-log text on any platform.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import {
  parsePageFileList, parsePerformanceInformation, parseWorkingSets, readPageFiles, readWindowsCommit, readWindowsProcessMemory,
} from "../../../src/services/assistant-mcp/assistant-system-windows-memory.ts";
import { systemResources, topProcesses, type ProcessRow, type ResourcesDeps } from "../../../src/services/assistant-mcp/assistant-system-resources-tool.ts";

const MB = 1024 * 1024;
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

describe("Windows struct parsing", () => {
  it("reads commit from PERFORMANCE_INFORMATION in pages", () => {
    const view = new DataView(new ArrayBuffer(104));
    view.setBigUint64(8, BigInt((40_000 * MB) / 4096), true);
    view.setBigUint64(16, BigInt((48_000 * MB) / 4096), true);
    view.setBigUint64(24, BigInt((60_000 * MB) / 4096), true);
    view.setBigUint64(80, 4096n, true);
    expect(parsePerformanceInformation(view)).toEqual({ commitUsedMB: 40_000, commitLimitMB: 48_000, commitPeakMB: 60_000, pageSize: 4096 });
    expect(parsePerformanceInformation(new DataView(new ArrayBuffer(104)))).toBeNull();
  });

  it("reads each page file and names it only from inside the buffer", () => {
    const buf = new ArrayBuffer(128);
    const view = new DataView(buf);
    const base = 0x10000n;
    const name = "\\??\\C:\\pagefile.sys";
    // First entry, name stored at offset 64; second entry's name points outside the buffer.
    view.setUint32(0, 32, true);
    view.setUint32(4, (16_000 * MB) / 4096, true);
    view.setUint32(8, (1_700 * MB) / 4096, true);
    view.setUint32(12, (5_000 * MB) / 4096, true);
    view.setUint16(16, name.length * 2, true);
    view.setBigUint64(24, base + 64n, true);
    for (let i = 0; i < name.length; i++) view.setUint16(64 + i * 2, name.charCodeAt(i), true);
    view.setUint32(32 + 4, (2 * MB * 1024) / 4096, true);
    view.setUint16(32 + 16, 10, true);
    view.setBigUint64(32 + 24, base + 999_999n, true);
    expect(parsePageFileList(view, base, 64, 4096)).toEqual([
      { name: "C:\\pagefile.sys", sizeMB: 16_000, inUseMB: 1_700, peakMB: 5_000 },
      { name: null, sizeMB: 2048, inUseMB: 0, peakMB: 0 },
    ]);
    expect(parsePageFileList(view, base, 0, 4096)).toEqual([]);
  });

  it("reads working sets by pid along the entry chain", () => {
    const view = new DataView(new ArrayBuffer(0x200));
    view.setUint32(0, 0x100, true);
    view.setBigUint64(0x50, 4n, true);
    view.setBigUint64(0x90, BigInt(300 * MB), true);
    view.setBigUint64(0x100 + 0x50, 8n, true);
    view.setBigUint64(0x100 + 0x90, BigInt(12 * MB), true);
    expect([...parseWorkingSets(view)]).toEqual([[4, 300], [8, 12]]);
  });

  it("answers nothing off Windows", async () => {
    expect(await readWindowsCommit("linux")).toBeNull();
    expect(await readPageFiles(4096, "darwin")).toBeNull();
    expect(await readWindowsProcessMemory("linux")).toBeNull();
  });

  it.if(process.platform === "win32")("reads this machine's commit, page files and its own process", async () => {
    const commit = await readWindowsCommit();
    expect(commit).not.toBeNull();
    expect(commit!.commitUsedMB).toBeGreaterThan(0);
    expect(commit!.commitLimitMB).toBeGreaterThanOrEqual(commit!.commitUsedMB);
    expect(Array.isArray(await readPageFiles(commit!.pageSize))).toBe(true);
    const me = (await readWindowsProcessMemory())?.find((p) => p.pid === process.pid);
    expect(me?.name).toBe("bun");
    expect(me!.workingSetMB).toBeGreaterThan(0);
    // Both are this process's resident set, read a moment apart.
    expect(Math.abs(me!.workingSetMB - process.memoryUsage().rss / MB)).toBeLessThan(200);
  });
});

describe("system_resources", () => {
  const procs: ProcessRow[] = [
    { name: "bun", pid: 10, ppid: 1, privateMB: 4000, workingSetMB: 900, startedAt: "2026-11-16T00:00:00.000Z" },
    { name: "chrome", pid: 11, ppid: 1, privateMB: 500, workingSetMB: 1500, startedAt: null },
    { name: "claude", pid: 12, ppid: 10, workingSetMB: 700, startedAt: null },
  ];
  const deps = (over: Partial<ResourcesDeps> = {}): ResourcesDeps => ({
    platform: "win32",
    memory: () => ({ totalMB: 32_000, usedMB: 24_000, availableMB: 8_000, percent: 75 }),
    uptimeSec: () => 3600,
    commit: async () => ({ commitUsedMB: 40_000, commitLimitMB: 48_000, commitPeakMB: 60_000, pageSize: 4096 }),
    pageFiles: async () => [{ name: "C:\\pagefile.sys", sizeMB: 16_000, inUseMB: 1_700, peakMB: 5_000 }],
    drives: async () => [{ name: "C:", path: "C:\\", kind: "fixed" }, { name: "Z:", path: "Z:\\", kind: "network" }],
    diskSpace: async (p) => (p === "C:\\" ? { totalMB: 500_000, freeMB: 8_000 } : null),
    processes: async () => procs,
    ...over,
  });

  it("answers memory, commit, page file, disks and the top processes", async () => {
    const r = JSON.parse(text(await systemResources({ top: 2 }, deps())));
    expect(r.memory).toMatchObject({ totalMB: 32_000, usedPercent: 75, commitUsedMB: 40_000, commitLimitMB: 48_000 });
    expect(r.memory.pageFiles[0].inUseMB).toBe(1_700);
    expect(r.disks).toEqual([
      { name: "C:", mount: "C:\\", kind: "fixed", totalMB: 500_000, freeMB: 8_000 },
      { name: "Z:", mount: "Z:\\", kind: "network", unreadable: true },
    ]);
    expect(r.processes.top.map((p: ProcessRow) => p.name)).toEqual(["bun", "claude"]);
    expect(r.lowMemoryEvents).toContain("not available");
  });

  it("sorts by working set when asked, and private bytes fall back to it where absent", () => {
    expect(topProcesses(procs, 3, "workingSet").map((p) => p.pid)).toEqual([11, 10, 12]);
    expect(topProcesses(procs, 3, "private").map((p) => p.pid)).toEqual([10, 12, 11]);
  });

  it("degrades a failed read to an error field, not a failed call", async () => {
    const r = JSON.parse(text(await systemResources({}, deps({ platform: "linux", commit: async () => null, processes: async () => { throw new Error("x"); } }))));
    expect(r.processes.error).toBeDefined();
    expect(r.memory.commitUsedMB).toBeUndefined();
    expect(r.lowMemoryEvents).toBeUndefined();
  });

  it("refuses bad arguments", async () => {
    expect((await systemResources({ top: 26 }, deps()) as { isError?: boolean }).isError).toBe(true);
    expect((await systemResources({ sortBy: "cpu" }, deps()) as { isError?: boolean }).isError).toBe(true);
  });

  it("never carries a command line or an environment, from the real readers either", async () => {
    const out = text(await systemResources({ top: 25 }));
    const body = JSON.parse(out);
    for (const p of body.processes.top ?? []) expect(Object.keys(p).sort()).toEqual(expect.arrayContaining(["name", "pid", "ppid", "workingSetMB", "startedAt"]));
    expect(out).not.toMatch(/"command"|"args"|"env"/);
    if (process.env.PATH) expect(out).not.toContain(process.env.PATH);
  });
});
