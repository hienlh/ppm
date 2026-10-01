/** Which launchd job each process belongs to: its main pid, and everything under it. */
import { describe, expect, test } from "bun:test";
import { createLaunchdJobIndex, STALE_AFTER_MS } from "../../../../src/services/system-services/launchd-job-index.ts";

const rows = [
  { pid: 1, ppid: 0 },        // launchd
  { pid: 100, ppid: 1 },      // a job's main process
  { pid: 110, ppid: 100 },    // its child
  { pid: 111, ppid: 110 },    // and grandchild
  { pid: 200, ppid: 1 },      // another job
  { pid: 300, ppid: 1 },      // an app, which is no listed job
  { pid: 310, ppid: 300 },
  { pid: 400, ppid: 1 },      // orphaned by a job's process: launchd adopted it
];

function index(at = 1000) {
  let clock = at;
  const idx = createLaunchdJobIndex(() => clock);
  return { idx, advance: (ms: number) => { clock += ms; } };
}

describe("createLaunchdJobIndex", () => {
  test("a job owns its main process and everything that process started", () => {
    const { idx } = index();
    idx.update([[100, "user:com.example.agent"], [200, "system:com.example.daemon"]]);
    expect([...idx.keysFor(rows)].sort()).toEqual([
      [100, "user:com.example.agent"],
      [110, "user:com.example.agent"],
      [111, "user:com.example.agent"],
      [200, "system:com.example.daemon"],
    ]);
  });

  test("before any listing, nothing belongs to a job", () => {
    expect(index().idx.keysFor(rows).size).toBe(0);
  });

  test("a listing nobody refreshed is not used: pids are reused", () => {
    const { idx, advance } = index();
    idx.update([[100, "user:com.example.agent"]]);
    advance(STALE_AFTER_MS);
    expect(idx.keysFor(rows).size).toBe(3);
    advance(1);
    expect(idx.keysFor(rows).size).toBe(0);
  });

  test("each listing replaces the last", () => {
    const { idx } = index();
    idx.update([[100, "user:com.example.agent"]]);
    idx.update([[200, "system:com.example.daemon"]]);
    expect([...idx.keysFor(rows).keys()]).toEqual([200]);
  });

  test("a malformed table with a loop in it does not hang the tick", () => {
    const { idx } = index();
    idx.update([[100, "user:com.example.agent"]]);
    expect(idx.keysFor([{ pid: 5, ppid: 6 }, { pid: 6, ppid: 5 }]).size).toBe(0);
  });
});
