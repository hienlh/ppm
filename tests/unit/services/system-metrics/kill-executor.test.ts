import { describe, test, expect } from "bun:test";
import { executeKill, type KillExecutorDeps } from "../../../../src/services/system-metrics/kill-executor.ts";

function fakeDeps(platform: NodeJS.Platform, alive: Set<number>) {
  const calls: string[] = [];
  const deps: KillExecutorDeps = {
    platform,
    run: async (argv) => { calls.push(argv.join(" ")); return { stdout: "", stderr: "", code: alive.has(Number(argv[2])) ? 0 : 128, timedOut: false }; },
    signal: (pid, sig) => {
      calls.push(`signal ${pid} ${sig}`);
      if (!alive.has(pid)) throw new Error("ESRCH");
      if (sig === "SIGKILL") alive.delete(pid);
    },
    collectTree: (pid) => [pid, pid + 1, pid + 2],
    terminateTree: async (pids, grace) => { calls.push(`terminateTree ${pids.join(",")} ${grace}`); },
    sleep: async () => {},
  };
  return { deps, calls };
}

describe("executeKill", () => {
  test("rejects an invalid pid before touching anything", async () => {
    const { deps, calls } = fakeDeps("win32", new Set());
    await expect(executeKill(0, false, deps)).rejects.toThrow(/Invalid PID/);
    await expect(executeKill(2.5, false, deps)).rejects.toThrow(/Invalid PID/);
    expect(calls).toEqual([]);
  });

  test("win32 single: taskkill /PID n /F as an argv array", async () => {
    const { deps, calls } = fakeDeps("win32", new Set([42]));
    expect(await executeKill(42, false, deps)).toEqual({ pid: 42, tree: false, method: "taskkill", killed: [42] });
    expect(calls).toEqual(["taskkill /PID 42 /F"]);
  });

  test("win32 single: a non-zero taskkill exit throws (→ 500)", async () => {
    const { deps } = fakeDeps("win32", new Set());
    await expect(executeKill(42, false, deps)).rejects.toThrow(/taskkill exited 128/);
  });

  test("win32 tree: async taskkill /T /F via the runner, reports only [pid]", async () => {
    const { deps, calls } = fakeDeps("win32", new Set([42]));
    expect(await executeKill(42, true, deps)).toEqual({ pid: 42, tree: true, method: "taskkill", killed: [42] });
    expect(calls).toEqual(["taskkill /PID 42 /T /F"]);
  });

  test("win32 tree: a failed or timed-out taskkill throws instead of reporting success", async () => {
    const { deps } = fakeDeps("win32", new Set());
    await expect(executeKill(42, true, deps)).rejects.toThrow(/taskkill exited 128/);
    deps.run = async () => ({ stdout: "", stderr: "", code: null, timedOut: true });
    await expect(executeKill(42, true, deps)).rejects.toThrow(/timeout/);
  });

  test("posix single: SIGTERM, then SIGKILL only if still alive after the grace", async () => {
    const stubborn = new Set([7]);
    const { deps, calls } = fakeDeps("linux", stubborn);
    // signal() with 0 reports liveness; TERM does not kill the stubborn pid.
    const r = await executeKill(7, false, deps);
    expect(r).toEqual({ pid: 7, tree: false, method: "signal", killed: [7] });
    expect(calls[0]).toBe("signal 7 SIGTERM");
    expect(calls.at(-1)).toBe("signal 7 SIGKILL");
  });

  test("posix single: a process that exits on SIGTERM is never SIGKILLed", async () => {
    const alive = new Set([8]);
    const { deps, calls } = fakeDeps("darwin", alive);
    deps.signal = (pid, sig) => { calls.push(`signal ${pid} ${sig}`); if (sig === "SIGTERM") alive.delete(pid); if (!alive.has(pid) && sig === 0) throw new Error("ESRCH"); };
    await executeKill(8, false, deps);
    expect(calls.some((c) => c.includes("SIGKILL"))).toBe(false);
  });

  test("posix tree: collects BEFORE signalling and hands the tree to terminateTree", async () => {
    const { deps, calls } = fakeDeps("linux", new Set([10, 11, 12]));
    const r = await executeKill(10, true, deps);
    expect(r).toEqual({ pid: 10, tree: true, method: "signal", killed: [10, 11, 12] });
    expect(calls).toEqual(["terminateTree 10,11,12 3000"]);
  });
});
