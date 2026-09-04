import { describe, test, expect } from "bun:test";
import {
  createWindowsProcessCollector,
  mergeCommand,
  WINDOWS_TICK_SCRIPT,
  WINDOWS_COMMANDLINE_SCRIPT,
} from "../../../../src/services/system-metrics/process-collector-windows.ts";
import { PowerShellSession, PS_DISABLED_WARNING } from "../../../../src/services/system-metrics/powershell-session.ts";
import { createFakeSpawner } from "./fixtures/fake-powershell-child.ts";

const T = "637134336000000000"; // 2020-01-01T00:00:00Z
const P_ROWS = [
  "P\t0\t0\tSystem Idle Process\t999\t0\t8192\t" + T + "\t0\t0",
  "P\t100\t4\tsvchost.exe\t1000000\t1000000\t1048576\t" + T + "\t4096\t8192",
  "P\t200\t100\tnode.exe\t20000000\t0\t2097152\t637134336010000000\t100000\t200000",
  "D\t1\t2\t30\t10",
  "N\tEth\t1\t2\t133000000000000000",
].join("\r\n");
const ENG_200 = "pid_200_luid_0x00000000_0x0000A1B2_phys_0_eng_0_engtype_3D";
const GPU_ROWS = ["G\t" + ENG_200 + "\t5000000\t133000000000000000", "M\tpid_200_luid_0x00000000_0x0000A1B2_phys_0\t536870912"].join("\r\n");
const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
const C_ROWS = ["C\t100\t" + T + "\t" + b64("C:\\Windows\\System32\\svchost.exe -k netsvcs"), "C\t200\t637134336010000000\t" + b64("node server.js")].join("\r\n");

describe("scripts", () => {
  test("the per-tick script queries Win32_Process once plus both raw perf classes; CommandLine is separate", () => {
    expect(WINDOWS_TICK_SCRIPT.match(/Get-CimInstance Win32_Process/g)).toHaveLength(1);
    expect(WINDOWS_TICK_SCRIPT).not.toContain("CommandLine");
    expect(WINDOWS_TICK_SCRIPT).toContain("Win32_PerfRawData_PerfDisk_PhysicalDisk");
    expect(WINDOWS_TICK_SCRIPT).toContain("Win32_PerfRawData_Tcpip_NetworkInterface");
    expect(WINDOWS_TICK_SCRIPT).toContain("ToUniversalTime()");
    expect(WINDOWS_TICK_SCRIPT).not.toContain("Get-Process");
  });

  test("per-process disk and GPU ride the SAME round trip; only busy engines are asked for", () => {
    expect(WINDOWS_TICK_SCRIPT).toContain("ReadTransferCount,WriteTransferCount");
    expect(WINDOWS_TICK_SCRIPT).toContain("Win32_PerfRawData_GPUPerformanceCounters_GPUEngine");
    expect(WINDOWS_TICK_SCRIPT).toContain("Win32_PerfRawData_GPUPerformanceCounters_GPUProcessMemory");
    // 505 engine instances on a dev box; the filter is what keeps the reply small.
    expect(WINDOWS_TICK_SCRIPT).toContain("Where-Object { $_.UtilizationPercentage -gt 0 }");
    expect(WINDOWS_TICK_SCRIPT).toContain("Timestamp_Sys100NS");
    expect(WINDOWS_TICK_SCRIPT).toContain("DedicatedUsage");
    // Still one process query, and still no second CIM round trip per tick.
    expect(WINDOWS_TICK_SCRIPT.match(/Get-CimInstance/g)).toHaveLength(5);
    expect(WINDOWS_COMMANDLINE_SCRIPT).toContain("CommandLine");
    // Argv is attacker-controlled and the transport is line-framed.
    expect(WINDOWS_COMMANDLINE_SCRIPT).toContain("[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine))");
  });
});

describe("createWindowsProcessCollector", () => {
  test("first tick fetches CommandLine; later ticks within 30 s do not; commands merge by pid+startedAt", async () => {
    let now = 100_000;
    const { spawn, children } = createFakeSpawner({
      autoReply: (script) => (script.includes("CommandLine") ? `${P_ROWS}\r\n${C_ROWS}` : P_ROWS),
    });
    const session = new PowerShellSession({ spawn });
    const c = createWindowsProcessCollector({ session, now: () => now });

    const first = await c.collect();
    expect(children[0]!.scripts[0]).toContain("CommandLine");
    expect(first.rows.map((r) => r.pid)).toEqual([100, 200]);
    expect(first.rows[1]!.command).toBe("node server.js");
    expect(first.disk).toEqual({ inBytes: 1, outBytes: 2, atSec: 3 });
    expect(first.net?.inBytes).toBe(1);

    now += 2000;
    const second = await c.collect();
    expect(children[0]!.scripts[1]).not.toContain("CommandLine");
    expect(second.rows[1]!.command).toBe("node server.js"); // cached
    expect(children).toHaveLength(1); // one child for both ticks

    now += 30_000;
    await c.collect();
    expect(children[0]!.scripts[2]).toContain("CommandLine");
    c.stop();
    expect(children[0]!.killed).toBe(true);
  });

  test("cumulative disk counts pass through; GPU % is rated in-collector and columns report disk+gpu, not net", async () => {
    let now = 100_000;
    // Same engine instance, 0.2 s busier one counter-second later.
    const BUSIER = ["G\t" + ENG_200 + "\t7000000\t133000000010000000", "M\tpid_200_luid_0x00000000_0x0000A1B2_phys_0\t536870912"].join("\r\n");
    let ticks = 0;
    const { spawn } = createFakeSpawner({
      autoReply: (script) => {
        const gpu = ticks++ === 0 ? GPU_ROWS : BUSIER;
        return script.includes("CommandLine") ? `${P_ROWS}\r\n${gpu}\r\n${C_ROWS}` : `${P_ROWS}\r\n${gpu}`;
      },
    });
    const c = createWindowsProcessCollector({ session: new PowerShellSession({ spawn }), now: () => now, log: () => {} });

    const first = await c.collect();
    const node = first.rows.find((r) => r.pid === 200)!;
    // Raw cumulative bytes: the rows builder, not the collector, makes them a rate.
    expect(node.diskReadBytes).toBe(100000);
    expect(node.diskWriteBytes).toBe(200000);
    // GPU is already a rate and is 0 on the first observation of the engine.
    expect(node.gpuPct).toBe(0);
    expect(node.gpuMemMB).toBe(512);
    // A pid with no engine instance is measured-and-idle, not unmeasurable.
    expect(first.rows.find((r) => r.pid === 100)!.gpuPct).toBe(0);
    expect(first.rows.find((r) => r.pid === 100)!.gpuMemMB).toBe(0);
    expect(first.columns).toEqual({ disk: true, gpu: true, net: false });

    // Second tick, +0.2 s of engine busy over a 1 s counter interval → 20 %.
    now += 2000;
    const second = await c.collect();
    expect(second.rows.find((r) => r.pid === 200)!.gpuPct).toBeCloseTo(20, 1);
    c.stop();
  });

  test("a tick whose GPU classes returned nothing leaves gpu figures undefined but keeps the column (sticky)", async () => {
    let withGpu = true;
    const { spawn } = createFakeSpawner({
      autoReply: () => (withGpu ? `${P_ROWS}\r\n${GPU_ROWS}` : P_ROWS),
    });
    const c = createWindowsProcessCollector({ session: new PowerShellSession({ spawn }), log: () => {} });
    await c.collect();
    withGpu = false;
    const r = await c.collect();
    expect(r.rows[0]!.gpuPct).toBeUndefined();
    expect(r.rows[0]!.gpuMemMB).toBeUndefined();
    // The UI must not lose (and re-add) a whole column because of one bad tick.
    expect(r.columns).toEqual({ disk: true, gpu: true, net: false });
    c.stop();
  });

  test("the round-trip cost is logged exactly once, so the 2 s tick budget is observable at startup", async () => {
    const logs: string[] = [];
    const { spawn } = createFakeSpawner({ autoReply: () => `${P_ROWS}\r\n${GPU_ROWS}` });
    const c = createWindowsProcessCollector({ session: new PowerShellSession({ spawn }), log: (m) => logs.push(m) });
    await c.collect();
    await c.collect();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("windows tick round trip");
    c.stop();
  });

  test("a pid missing from the last CommandLine fetch falls back to command null (→ name)", () => {
    const row = { pid: 5, ppid: 1, name: "x", command: null, cpuMs: 0, ramMB: 0, startedAt: 1000 };
    expect(mergeCommand(row, undefined)).toBeNull();
    expect(mergeCommand(row, { pid: 5, startedAt: 1000, command: "x --y" })).toBe("x --y");
    // Same pid, different start: recycled since the fetch — do not show the old command.
    expect(mergeCommand(row, { pid: 5, startedAt: 2000, command: "old" })).toBeNull();
    // Unknown start on either side cannot prove a mismatch.
    expect(mergeCommand({ ...row, startedAt: 0 }, { pid: 5, startedAt: 2000, command: "ok" })).toBe("ok");
  });

  test("a disabled session yields the disabled warning and no rows, without throwing", async () => {
    const { spawn } = createFakeSpawner();
    const session = new PowerShellSession({ spawn, requestTimeoutMs: 5, maxRestarts: 0 });
    const c = createWindowsProcessCollector({ session });
    await expect(c.collect()).rejects.toThrow(/timed out/);
    // Budget exhausted (0 restarts allowed) → the next call is disabled.
    const r = await c.collect();
    expect(r.rows).toEqual([]);
    expect(r.warnings).toEqual([PS_DISABLED_WARNING]);
    expect(r.disk).toBeUndefined();
  });

  test("__ERR__ lines from a failed block become warnings while the rest of the tick is kept", async () => {
    const { spawn } = createFakeSpawner({ autoReply: () => `${P_ROWS}\r\n__ERR__ perf counters broken` });
    const c = createWindowsProcessCollector({ session: new PowerShellSession({ spawn }) });
    const r = await c.collect();
    expect(r.rows).toHaveLength(2);
    expect(r.warnings).toEqual(["PowerShell: perf counters broken"]);
    c.stop();
  });
});
