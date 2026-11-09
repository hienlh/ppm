/**
 * Reading another process's main thread from outside it.
 *
 * When the server stops answering, its own logs cannot say why — the loop that would
 * write them is the thing that stopped. The supervisor reads the main thread's wait
 * from outside instead; that one word (`WrPageIn`, `Executive`, running) is what
 * separated "blocked on a page-in" from "busy with our own code" on 26/10/2026.
 */
import { describe, it, expect } from "bun:test";
import {
  parseWindowsProcessInformation,
  parseLinuxStat,
  readThreadSnapshot,
  describeThreadSnapshot,
} from "../../../src/services/process-thread-snapshot.ts";

const P_SIZE = 0x100;
const T_SIZE = 0x50;

/** A `SystemProcessInformation` buffer: one process entry per item, each followed by its threads. */
function processInfo(entries: Array<{ pid: number; hardFaults: number; userTicks: bigint; kernelTicks: bigint; threads: Array<{ created: bigint; state: number; reason: number }> }>): DataView {
  const sizes = entries.map((e) => P_SIZE + e.threads.length * T_SIZE);
  const view = new DataView(new ArrayBuffer(sizes.reduce((a, b) => a + b, 0)));
  let at = 0;
  entries.forEach((e, i) => {
    view.setUint32(at, i === entries.length - 1 ? 0 : sizes[i]!, true);
    view.setUint32(at + 0x04, e.threads.length, true);
    view.setUint32(at + 0x10, e.hardFaults, true);
    view.setBigInt64(at + 0x28, e.userTicks, true);
    view.setBigInt64(at + 0x30, e.kernelTicks, true);
    view.setBigUint64(at + 0x50, BigInt(e.pid), true);
    e.threads.forEach((t, j) => {
      const th = at + P_SIZE + j * T_SIZE;
      view.setBigInt64(th + 0x10, t.created, true);
      view.setUint32(th + 0x44, t.state, true);
      view.setUint32(th + 0x48, t.reason, true);
    });
    at += sizes[i]!;
  });
  return view;
}

describe("Windows: finding the process and its main thread", () => {
  const view = processInfo([
    { pid: 4, hardFaults: 0, userTicks: 0n, kernelTicks: 0n, threads: [{ created: 1n, state: 2, reason: 0 }] },
    {
      pid: 24380, hardFaults: 628, userTicks: 30_000_000n, kernelTicks: 10_000_000n,
      threads: [
        { created: 500n, state: 5, reason: 15 }, // a worker, idle
        { created: 100n, state: 5, reason: 9 }, // created first: the main thread, in WrPageIn
        { created: 900n, state: 2, reason: 0 },
      ],
    },
  ]);

  it("names the wait of the thread that was created first", () => {
    expect(parseWindowsProcessInformation(view, 24380)).toEqual({
      threads: 3,
      hardFaults: 628,
      cpuMs: 4000, // (3e7 + 1e7) × 100 ns
      state: "waiting",
      waitReason: "WrPageIn",
    });
  });

  it("gives no wait reason to a thread that is not waiting", () => {
    const s = parseWindowsProcessInformation(view, 4);
    expect(s?.state).toBe("running");
    expect(s && "waitReason" in s).toBe(false);
  });

  it("answers null for a process that is not in the list", () => {
    expect(parseWindowsProcessInformation(view, 999)).toBeNull();
  });
});

describe("Linux: /proc/<pid>/stat", () => {
  it("reads state, major faults, CPU and threads past a command name with spaces and parentheses", () => {
    // Fields 3.. after the name: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads
    const line = "1234 (bun (server) x) D 1 1234 1234 0 -1 4194560 9000 0 77 0 250 50 0 0 20 0 31 0 100";
    expect(parseLinuxStat(line, 100)).toEqual({ state: "disk-wait", hardFaults: 77, cpuMs: 3000, threads: 31 });
  });
});

describe("one line for the log", () => {
  it("reports faults and CPU as the change since the previous reading", () => {
    const before = { hardFaults: 600, cpuMs: 4000 };
    const now = { state: "waiting", waitReason: "WrPageIn", hardFaults: 638, cpuMs: 4120 };
    expect(describeThreadSnapshot(now, before)).toBe("main thread waiting/WrPageIn, hard faults +38, server cpu +120ms");
  });

  it("falls back to totals when there is nothing to compare with", () => {
    expect(describeThreadSnapshot({ state: "running", hardFaults: 12, cpuMs: 50 })).toBe("main thread running, hard faults 12");
  });
});

describe.if(process.platform === "win32" || process.platform === "linux")("against a real process", () => {
  it("sees this test's own main thread running", async () => {
    const s = await readThreadSnapshot(process.pid);
    expect(s).not.toBeNull();
    expect(s!.state).toBe("running");
    expect(s!.threads).toBeGreaterThan(0);
    expect(s!.cpuMs).toBeGreaterThan(0);
  });
});
