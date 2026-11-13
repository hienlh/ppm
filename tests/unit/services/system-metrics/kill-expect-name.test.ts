import { describe, test, expect } from "bun:test";
import { handleKillRequest, parseKillRequest, type KillHandlerDeps } from "../../../../src/services/system-metrics/kill-request-handler.ts";
import { handleSignalRequest, parseSignalRequest, type SignalHandlerDeps } from "../../../../src/services/system-metrics/signal-request-handler.ts";
import type { ProcessCollector } from "../../../../src/services/system-metrics/process-collector-types.ts";
import { raw } from "./fixtures/process-fixtures.ts";

// A stand-in table: nothing here reaches a real process, every executor only records.
const ROWS = [raw(1, 0, "systemd"), raw(500, 1, "Node.EXE"), raw(600, 1, "vim")];
const collector: ProcessCollector = { collect: async () => ({ rows: ROWS, warnings: [] }), stop: () => {} };
const quiet = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, isEnabled: () => false };
const noProviders = () => new Set<number>();

function killDeps(executed: number[]): KillHandlerDeps {
  return {
    platform: "linux", collector, log: quiet, providerPids: noProviders,
    resolveProtected: () => ({ pids: new Set(), roots: new Set(), selfPid: 0 }),
    execute: async (pid, tree) => { executed.push(pid); return { pid, tree, method: "signal", killed: [pid] }; },
  };
}

function signalDeps(executed: number[]): SignalHandlerDeps {
  return {
    platform: "linux", collector, log: quiet, providerPids: noProviders, supported: ["TERM", "KILL", "STOP"],
    resolveProtected: () => ({ pids: new Set(), roots: new Set(), selfPid: 0 }),
    execute: async (pid, signal, tree) => { executed.push(pid); return { pid, signal, tree, method: "signal", signalled: [pid] }; },
  };
}

describe("expectName in the request body", () => {
  test("is optional, trimmed, and kept only when given", () => {
    expect(parseKillRequest({ pid: 5, startedAt: 0 })).toEqual({ pid: 5, startedAt: 0, tree: false });
    expect(parseKillRequest({ pid: 5, startedAt: 0, expectName: " node " })?.expectName).toBe("node");
    expect(parseSignalRequest({ pid: 5, startedAt: 0, signal: "TERM", expectName: "vim" })?.expectName).toBe("vim");
  });

  test("anything but a short non-empty string makes the body malformed", () => {
    for (const bad of [5, "", "   ", null, "x".repeat(257)]) {
      expect(parseKillRequest({ pid: 5, startedAt: 0, expectName: bad })).toBeNull();
      expect(parseSignalRequest({ pid: 5, startedAt: 0, signal: "TERM", expectName: bad })).toBeNull();
    }
  });
});

describe("a kill or a signal with the wrong name ends nothing", () => {
  test("kill: a mismatch is a 409 naming the live process, and the executor is never called", async () => {
    const executed: number[] = [];
    const r = await handleKillRequest({ pid: 600, startedAt: 1_000_600, expectName: "node" }, killDeps(executed));
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('"vim"');
    expect(r.body.error).toContain("nothing was done");
    expect(executed).toEqual([]);
  });

  test("signal: the same check, the same answer", async () => {
    const executed: number[] = [];
    const r = await handleSignalRequest({ pid: 600, startedAt: 1_000_600, signal: "STOP", expectName: "bash" }, signalDeps(executed));
    expect(r.status).toBe(409);
    expect(executed).toEqual([]);
  });

  test("case and a Windows extension are ignored on both sides", async () => {
    const executed: number[] = [];
    expect((await handleKillRequest({ pid: 500, startedAt: 1_000_500, expectName: "node" }, killDeps(executed))).status).toBe(200);
    expect((await handleSignalRequest({ pid: 500, startedAt: 1_000_500, signal: "TERM", expectName: "NODE.exe" }, signalDeps(executed))).status).toBe(200);
    expect(executed).toEqual([500, 500]);
  });

  test("without expectName the request behaves as before", async () => {
    const executed: number[] = [];
    expect((await handleKillRequest({ pid: 600, startedAt: 1_000_600 }, killDeps(executed))).status).toBe(200);
    expect(executed).toEqual([600]);
  });

  test("the identity check still comes first: a reused pid is 409 for that reason", async () => {
    const executed: number[] = [];
    const r = await handleKillRequest({ pid: 600, startedAt: 99, expectName: "vim" }, killDeps(executed));
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("recycled");
    expect(executed).toEqual([]);
  });
});
