import { describe, test, expect } from "bun:test";
import { computePpmPids } from "../../../../src/services/system-metrics/ppm-process-ownership.ts";
import { WIN_DEV_HOST, WIN_RUN_PID, WIN_SERVER_PID } from "./fixtures/process-fixtures.ts";

const ppidOf = new Map(WIN_DEV_HOST.map((p) => [p.pid, p.ppid]));
const startedAtOf = new Map(WIN_DEV_HOST.map((p) => [p.pid, p.startedAt]));

describe("computePpmPids", () => {
  test("roots plus every descendant via the every-tick ppid map", () => {
    const pids = computePpmPids({ roots: new Set([WIN_SERVER_PID, WIN_RUN_PID]), extraPids: [], ppidOf, startedAtOf });
    expect([...pids].sort()).toEqual([3000, 3100, 3200, 3300]);
  });

  test("ancestors (WindowsTerminal, explorer) are never PPM", () => {
    const pids = computePpmPids({ roots: new Set([WIN_SERVER_PID]), extraPids: [], ppidOf, startedAtOf });
    expect(pids.has(2000)).toBe(false);
    expect(pids.has(1000)).toBe(false);
    expect(pids.has(WIN_RUN_PID)).toBe(false);
  });

  test("tunnelPid is owned outright when present in the table; a missing pid is ignored", () => {
    const pids = computePpmPids({ roots: new Set([WIN_SERVER_PID]), extraPids: [4000, 99999], ppidOf, startedAtOf });
    expect(pids.has(4000)).toBe(true);
    expect(pids.has(99999)).toBe(false);
  });

  test("missing status.json → only the server root and its subtree", () => {
    const pids = computePpmPids({ roots: new Set([WIN_SERVER_PID]), extraPids: [], ppidOf, startedAtOf });
    expect([...pids].sort()).toEqual([3100, 3200, 3300]);
  });

  test("a root absent from the table contributes nothing", () => {
    expect(computePpmPids({ roots: new Set([424242]), extraPids: [], ppidOf, startedAtOf }).size).toBe(0);
  });

  test("a child that predates its recorded parent is a recycled-pid adoption and is not claimed", () => {
    const ppid = new Map([[10, 0], [20, 10]]);
    const started = new Map([[10, 5000], [20, 1000]]);
    expect(computePpmPids({ roots: new Set([10]), extraPids: [], ppidOf: ppid, startedAtOf: started }).has(20)).toBe(false);
  });
});
