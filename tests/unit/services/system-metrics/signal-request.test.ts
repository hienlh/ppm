import { describe, test, expect } from "bun:test";
import {
  executeSignal, supportedSignals, WINDOWS_SUPPORTED_SIGNALS,
} from "../../../../src/services/system-metrics/signal-executor.ts";
import {
  handleSignalRequest, parseSignalRequest,
} from "../../../../src/services/system-metrics/signal-request-handler.ts";
import type { RawProcessRow } from "../../../../src/services/system-metrics/process-collector-types.ts";
import type { ProcessSignal } from "../../../../src/types/system-metrics.ts";

const row = (pid: number, ppid: number, name: string, startedAt: number): RawProcessRow =>
  ({ pid, ppid, name, command: null, cpuMs: 0, ramMB: 1, startedAt });

describe("parseSignalRequest", () => {
  test("a well-formed request", () => {
    expect(parseSignalRequest({ pid: 42, startedAt: 1000, signal: "STOP" }))
      .toEqual({ pid: 42, startedAt: 1000, signal: "STOP", tree: false });
    expect(parseSignalRequest({ pid: 42, startedAt: 1000, signal: "KILL", tree: true })?.tree).toBe(true);
  });

  test("an unknown signal name is refused rather than passed to process.kill", () => {
    expect(parseSignalRequest({ pid: 1, startedAt: 1, signal: "SIGKILL" })).toBeNull();
    expect(parseSignalRequest({ pid: 1, startedAt: 1, signal: "KILL; rm -rf /" })).toBeNull();
    expect(parseSignalRequest({ pid: 1, startedAt: 1, signal: 9 })).toBeNull();
  });

  test("a missing or nonsensical pid/startedAt is refused", () => {
    expect(parseSignalRequest({ startedAt: 1, signal: "TERM" })).toBeNull();
    expect(parseSignalRequest({ pid: 0, startedAt: 1, signal: "TERM" })).toBeNull();
    expect(parseSignalRequest({ pid: 1.5, startedAt: 1, signal: "TERM" })).toBeNull();
    expect(parseSignalRequest({ pid: 1, signal: "TERM" })).toBeNull();
    expect(parseSignalRequest(null)).toBeNull();
  });
});

describe("supportedSignals", () => {
  test("POSIX offers all eight, Windows only the two taskkill can mean", () => {
    expect(supportedSignals("linux")).toHaveLength(8);
    expect(supportedSignals("darwin")).toContain("USR1");
    expect(supportedSignals("win32")).toEqual([...WINDOWS_SUPPORTED_SIGNALS]);
  });
});

describe("executeSignal", () => {
  const deps = (over: Partial<Parameters<typeof executeSignal>[3]> = {}) => {
    const sent: [number, string][] = [];
    return {
      sent,
      deps: {
        platform: "linux" as NodeJS.Platform,
        run: async () => ({ stdout: "", stderr: "", code: 0, timedOut: false }),
        signal: (pid: number, sig: NodeJS.Signals) => { sent.push([pid, sig]); },
        collectTree: (pid: number) => [pid + 2, pid + 1, pid],
        ...over,
      },
    };
  };

  test("sends exactly the signal asked for — no TERM-then-KILL escalation", async () => {
    const { sent, deps: d } = deps();
    const r = await executeSignal(100, "STOP", false, d);
    expect(sent).toEqual([[100, "SIGSTOP"]]);
    expect(r).toEqual({ pid: 100, signal: "STOP", tree: false, method: "signal", signalled: [100] });
  });

  test("a tree is enumerated BEFORE anything is signalled", async () => {
    const order: string[] = [];
    const { sent, deps: d } = deps({
      collectTree: (pid: number) => { order.push("walk"); return [pid + 1, pid]; },
      signal: (pid: number) => { order.push(`signal:${pid}`); },
    });
    await executeSignal(50, "TERM", true, d);
    expect(order[0]).toBe("walk");
    expect(sent).toEqual([]);
    expect(order).toEqual(["walk", "signal:51", "signal:50"]);
  });

  test("a process exiting mid-sweep is simply not in the result", async () => {
    const { deps: d } = deps({
      collectTree: () => [1, 2, 3],
      signal: (pid: number) => { if (pid === 2) throw new Error("ESRCH"); },
    });
    const r = await executeSignal(1, "HUP", true, d);
    expect(r.signalled).toEqual([1, 3]);
  });

  test("an invalid pid never reaches process.kill", async () => {
    const { sent, deps: d } = deps();
    await expect(executeSignal(0, "TERM", false, d)).rejects.toThrow("Invalid PID");
    await expect(executeSignal(-1, "TERM", false, d)).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  test("Windows refuses a signal taskkill cannot express, and never guesses", async () => {
    const { deps: d } = deps({ platform: "win32" as NodeJS.Platform });
    await expect(executeSignal(10, "STOP", false, d)).rejects.toThrow("cannot deliver SIGSTOP");
    const r = await executeSignal(10, "TERM", false, d);
    expect(r.method).toBe("taskkill");
  });

  test("a non-zero taskkill exit is reported, never masked", async () => {
    const { deps: d } = deps({
      platform: "win32" as NodeJS.Platform,
      run: async () => ({ stdout: "", stderr: "Access is denied.", code: 1, timedOut: false }),
    });
    await expect(executeSignal(10, "KILL", false, d)).rejects.toThrow("Access is denied.");
  });
});

describe("handleSignalRequest", () => {
  const rows = [row(1, 0, "systemd", 1), row(300, 1, "bun", 10), row(400, 1, "vim", 20)];
  const harness = (over: Record<string, unknown> = {}) => {
    const executed: unknown[] = [];
    const logs: string[] = [];
    return {
      executed, logs,
      deps: {
        platform: "linux" as const,
        collector: { collect: async () => ({ rows, warnings: [] }), stop: () => {} },
        resolveProtected: () => ({ pids: new Set([300]), roots: new Set([300]), selfPid: 300 }),
        execute: async (pid: number, signal: ProcessSignal, tree: boolean) => {
          executed.push([pid, signal, tree]);
          return { pid, signal, tree, method: "signal" as const, signalled: [pid] };
        },
        supported: supportedSignals("linux"),
        log: (l: string) => { logs.push(l); },
        ...over,
      },
    };
  };

  test("a signal this host cannot deliver is a 400 before any re-query", async () => {
    let collected = 0;
    const h = harness({
      supported: supportedSignals("win32"),
      collector: { collect: async () => { collected++; return { rows, warnings: [] }; }, stop: () => {} },
    });
    const r = await handleSignalRequest({ pid: 400, startedAt: 20, signal: "USR1" }, h.deps as never);
    expect(r.status).toBe(400);
    expect(collected).toBe(0);
  });

  test("a pid that is gone is a 404, not a signal into the void", async () => {
    const h = harness();
    const r = await handleSignalRequest({ pid: 999, startedAt: 1, signal: "TERM" }, h.deps as never);
    expect(r.status).toBe(404);
    expect(h.executed).toEqual([]);
  });

  test("a recycled pid is a 409 — the identity guard is the same one kill uses", async () => {
    const h = harness();
    const r = await handleSignalRequest({ pid: 400, startedAt: 999999, signal: "KILL" }, h.deps as never);
    expect(r.status).toBe(409);
    expect(h.executed).toEqual([]);
  });

  test("a PPM process cannot be signalled either — one guard, not two lists", async () => {
    const h = harness();
    const r = await handleSignalRequest({ pid: 300, startedAt: 10, signal: "STOP" }, h.deps as never);
    expect(r.status).toBe(403);
    expect(h.executed).toEqual([]);
    expect(h.logs.some((l) => l.includes("refused"))).toBe(true);
  });

  test("SIGSTOP on an OS-critical process is refused as firmly as a kill would be", async () => {
    const h = harness();
    const r = await handleSignalRequest({ pid: 1, startedAt: 1, signal: "STOP" }, h.deps as never);
    expect(r.status).toBe(403);
  });

  test("an allowed signal reaches the executor and is audited without a command line", async () => {
    const h = harness();
    const r = await handleSignalRequest({ pid: 400, startedAt: 20, signal: "USR1", tree: true }, h.deps as never);
    expect(r.status).toBe(200);
    expect(h.executed).toEqual([[400, "USR1", true]]);
    expect(h.logs.join("\n")).toContain("signal=USR1 pid=400 name=vim tree=true");
    expect(h.logs.join("\n")).not.toContain("command");
  });

  test("an executor failure is a 500 carrying the reason", async () => {
    const h = harness({ execute: async () => { throw new Error("EPERM"); } });
    const r = await handleSignalRequest({ pid: 400, startedAt: 20, signal: "TERM" }, h.deps as never);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).toContain("EPERM");
  });
});
