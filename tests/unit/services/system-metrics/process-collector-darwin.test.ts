import { describe, test, expect } from "bun:test";
import {
  parsePsCpuTime,
  parseDarwinPsTick,
  parseDarwinPsArgs,
  stabilizeStartedAt,
  executablePath,
  createDarwinProcessCollector,
  DARWIN_TICK_ARGV,
  DARWIN_ARGS_ARGV,
} from "../../../../src/services/system-metrics/process-collector-darwin.ts";
import type { Runner } from "../../../../src/services/host-info/spawn-runner.ts";
import { createLaunchdJobIndex } from "../../../../src/services/system-services/launchd-job-index.ts";

// Hand-authored `ps -Ao pid=,ppid=,etime=,time=,rss=,comm=` — UNVERIFIED on real macOS.
const TICK = [
  "    1     0 10-02:03:04  1:02:03.45   12000 /sbin/launchd",
  "  512     1    05:06:07     0:01.50   40960 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "  777   512       01:02     0:00.05    2048 /usr/bin/python3",
].join("\n");

const ARGS = [
  "    1 /sbin/launchd",
  "  512 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=browser --flag with space",
].join("\n");

describe("parsePsCpuTime", () => {
  test("all four shapes → milliseconds", () => {
    expect(parsePsCpuTime("0:00.05")).toBe(50);
    expect(parsePsCpuTime("12:34")).toBe((12 * 60 + 34) * 1000);
    expect(parsePsCpuTime("1:02:03.45")).toBe(((1 * 60 + 2) * 60 + 3.45) * 1000);
    expect(parsePsCpuTime("10-02:03:04")).toBe((((10 * 24 + 2) * 60 + 3) * 60 + 4) * 1000);
  });

  test("garbage → 0", () => {
    expect(parsePsCpuTime("-")).toBe(0);
    expect(parsePsCpuTime("")).toBe(0);
  });
});

describe("parseDarwinPsTick", () => {
  test("comm with spaces survives because it is the last column; name is the basename", () => {
    const now = 2_000_000_000_000;
    const rows = parseDarwinPsTick(TICK, now);
    expect(rows).toHaveLength(3);
    const chrome = rows[1]!;
    expect(chrome.name).toBe("Google Chrome");
    expect(chrome.ppid).toBe(1);
    expect(chrome.cpuMs).toBe(1500);
    expect(chrome.ramMB).toBe(40);
    expect(chrome.startedAt).toBe(now - (5 * 3600 + 6 * 60 + 7) * 1000);
    expect(chrome.command).toBeNull();
    expect(chrome.exePath).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  test("a process that retitled itself has no executable path", () => {
    const [row] = parseDarwinPsTick("  901   777       00:07     0:00.20    3072 npm exec @playwright/mcp@latest", 1_000_000);
    expect(row!.exePath).toBeUndefined();
  });
});

describe("executablePath", () => {
  const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  test("the kernel's path when ps printed a relative one", () => {
    const helper = "/Applications/Example.app/Contents/Library/LoginItems/ExampleHelper.app/Contents/MacOS/ExampleHelper";
    expect(executablePath(undefined, helper)).toBe(helper);
  });

  test("the kernel's path when a process retitled itself as something else", () => {
    // A node MCP server that titled itself as a browser.
    const title = "/Applications/Example Browser.app/Contents/MacOS/Example Browser --profile-dir-name Profile 1";
    expect(executablePath(title, "/usr/local/bin/node")).toBe("/usr/local/bin/node");
  });

  test("ps's path when the kernel names the same file somewhere else", () => {
    // Chrome runs itself from a clone of its bundle, which is no app bundle.
    const clone = "/private/var/folders/x/X/com.google.Chrome.code_sign_clone/c.1/Google Chrome.app.bundle/Contents/MacOS/Google Chrome";
    expect(executablePath(CHROME, clone)).toBe(CHROME);
  });

  test("ps's path when the kernel has none, as for a zombie", () => {
    expect(executablePath(CHROME, undefined)).toBe(CHROME);
    expect(executablePath(undefined, undefined)).toBeUndefined();
  });
});

describe("parseDarwinPsArgs", () => {
  test("keeps the full argv including spaces", () => {
    const m = parseDarwinPsArgs(ARGS);
    expect(m.get(512)).toContain("--flag with space");
    expect(m.size).toBe(2);
  });
});

describe("stabilizeStartedAt", () => {
  test("pins a pid to its first start time across sub-second jitter, resets on a real recycle", () => {
    const memo = new Map<number, number>();
    stabilizeStartedAt([{ pid: 9, ppid: 1, name: "x", command: null, cpuMs: 0, ramMB: 0, startedAt: 10_000 }], memo);
    const [again] = stabilizeStartedAt([{ pid: 9, ppid: 1, name: "x", command: null, cpuMs: 0, ramMB: 0, startedAt: 11_000 }], memo);
    expect(again!.startedAt).toBe(10_000);
    const [recycled] = stabilizeStartedAt([{ pid: 9, ppid: 1, name: "x", command: null, cpuMs: 0, ramMB: 0, startedAt: 99_000 }], memo);
    expect(recycled!.startedAt).toBe(99_000);
  });
});

describe("createDarwinProcessCollector", () => {
  test("one ps per tick; the args pass only on its 30 s cadence; commands merged by pid", async () => {
    const calls: string[][] = [];
    const run: Runner = async (argv) => {
      calls.push(argv);
      return { stdout: argv === DARWIN_ARGS_ARGV ? ARGS : TICK, stderr: "", code: 0, timedOut: false };
    };
    let t = 1_000_000;
    const c = createDarwinProcessCollector(run, () => t);
    const first = await c.collect();
    expect(first.rows.find((r) => r.pid === 512)!.command).toContain("--type=browser");
    expect(first.rows.find((r) => r.pid === 777)!.command).toBeNull();
    t += 2000;
    await c.collect();
    expect(calls).toEqual([DARWIN_TICK_ARGV, DARWIN_ARGS_ARGV, DARWIN_TICK_ARGV]);
  });

  test("ps failure → warning, no rows", async () => {
    const run: Runner = async () => ({ stdout: "", stderr: "x", code: 1, timedOut: false });
    const r = await createDarwinProcessCollector(run).collect();
    expect(r.rows).toEqual([]);
    expect(r.warnings[0]).toContain("ps exited");
    expect(r.columns).toEqual({ disk: false, gpu: false, net: false, swap: false, gpuMemory: false });
  });

  test("without injected sources no unit test can spawn nettop or ioreg, and no optional column is offered", async () => {
    const run: Runner = async () => ({ stdout: TICK, stderr: "", code: 0, timedOut: false });
    const r = await createDarwinProcessCollector(run).collect();
    expect(r.columns).toEqual({ disk: false, gpu: false, net: false, swap: false, gpuMemory: false });
    expect(r.rows[0]!.netInBytes).toBeUndefined();
    expect(r.rows[0]!.diskReadBytes).toBeUndefined();
    expect(r.rows[0]!.gpuPct).toBeUndefined();
  });

  test("nettop bytes attach as CUMULATIVE counters; macOS is the only OS that offers the Net column", async () => {
    const run: Runner = async () => ({ stdout: TICK, stderr: "", code: 0, timedOut: false });
    const r = await createDarwinProcessCollector(run, () => 1_000_000, {
      net: { isDisabled: () => false, collect: async () => new Map([[512, { inBytes: 1441792, outBytes: 262144 }]]) },
    }).collect();
    const chrome = r.rows.find((x) => x.pid === 512)!;
    expect(chrome.netInBytes).toBe(1441792);
    expect(chrome.netOutBytes).toBe(262144);
    // nettop lists only processes with sockets: absent means no traffic, measured.
    expect(r.rows.find((x) => x.pid === 777)!.netInBytes).toBe(0);
    expect(r.columns).toEqual({ disk: false, gpu: false, net: true, swap: false, gpuMemory: false });
  });

  test("a failed nettop sample leaves the rows without net figures rather than zeros", async () => {
    const run: Runner = async () => ({ stdout: TICK, stderr: "", code: 0, timedOut: false });
    const r = await createDarwinProcessCollector(run, () => 1_000_000, {
      net: { isDisabled: () => true, collect: async () => null },
    }).collect();
    expect(r.rows[0]!.netInBytes).toBeUndefined();
    expect(r.columns!.net).toBe(false);
  });

  test("GPU % comes from the accelerator read the GPU page shares; a pid with no GPU time is measured at 0", async () => {
    const run: Runner = async () => ({ stdout: TICK, stderr: "", code: 0, timedOut: false });
    const r = await createDarwinProcessCollector(run, () => 1_000_000, {
      gpu: { usage: async () => ({ atSec: 1000, accelerators: [], perProcess: new Map([[512, 12.5]]) }) },
    }).collect();
    expect(r.rows.find((x) => x.pid === 512)!.gpuPct).toBe(12.5);
    expect(r.rows.find((x) => x.pid === 777)!.gpuPct).toBe(0);
    // The GPU's memory is system memory, already in each process's RAM figure.
    expect(r.columns).toMatchObject({ gpu: true, gpuMemory: false });
  });

  test("a failed accelerator read leaves the rows without GPU figures rather than zeros", async () => {
    const run: Runner = async () => ({ stdout: TICK, stderr: "", code: 0, timedOut: false });
    const r = await createDarwinProcessCollector(run, () => 1_000_000, { gpu: { usage: async () => undefined } }).collect();
    expect(r.rows[0]!.gpuPct).toBeUndefined();
    expect(r.columns!.gpu).toBe(false);
  });

  test("disk bytes attach as CUMULATIVE counters; a process macOS refuses has none", async () => {
    const run: Runner = async () => ({ stdout: TICK, stderr: "", code: 0, timedOut: false });
    const r = await createDarwinProcessCollector(run, () => 1_000_000, {
      diskIo: (pid) => (pid === 512 ? { readBytes: 4096, writeBytes: 8192 } : undefined),
    }).collect();
    const chrome = r.rows.find((x) => x.pid === 512)!;
    expect([chrome.diskReadBytes, chrome.diskWriteBytes]).toEqual([4096, 8192]);
    // launchd belongs to root: an em dash, not a confident 0.
    expect(r.rows.find((x) => x.pid === 1)!.diskReadBytes).toBeUndefined();
    expect(r.columns!.disk).toBe(true);
  });

  test("each row's path is the one executablePath picks from ps and the kernel", async () => {
    const run: Runner = async () => ({ stdout: TICK, stderr: "", code: 0, timedOut: false });
    const kernel = new Map([[777, "/opt/homebrew/Cellar/python@3.12/3.12.7/bin/python3.12"]]);
    const r = await createDarwinProcessCollector(run, () => 1_000_000, { processPath: (pid) => kernel.get(pid) }).collect();
    expect(r.rows.find((x) => x.pid === 777)!.exePath).toBe("/opt/homebrew/Cellar/python@3.12/3.12.7/bin/python3.12");
    // No kernel answer: what ps printed.
    expect(r.rows.find((x) => x.pid === 512)!.exePath).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  test("a host that refuses every pid does not offer the Disk column", async () => {
    const run: Runner = async () => ({ stdout: TICK, stderr: "", code: 0, timedOut: false });
    const r = await createDarwinProcessCollector(run, () => 1_000_000, { diskIo: () => undefined }).collect();
    expect(r.columns!.disk).toBe(false);
  });

  test("a job's main process and what it started carry the job's key, from the Services listing", async () => {
    const run: Runner = async () => ({ stdout: TICK, stderr: "", code: 0, timedOut: false });
    const index = createLaunchdJobIndex(() => 1_000_000);
    index.update([[512, "user:com.example.browser"]]);
    const r = await createDarwinProcessCollector(run, () => 1_000_000, { jobKeys: (rows) => index.keysFor(rows) }).collect();
    expect(r.rows.find((x) => x.pid === 512)!.unitKey).toBe("user:com.example.browser");
    expect(r.rows.find((x) => x.pid === 777)!.unitKey).toBe("user:com.example.browser");
    // launchd is no job's: the property is absent, not empty.
    expect("unitKey" in r.rows.find((x) => x.pid === 1)!).toBe(false);
  });

  test("without a job index no row claims a job", async () => {
    const run: Runner = async () => ({ stdout: TICK, stderr: "", code: 0, timedOut: false });
    const r = await createDarwinProcessCollector(run, () => 1_000_000).collect();
    expect(r.rows.some((x) => "unitKey" in x)).toBe(false);
  });
});
