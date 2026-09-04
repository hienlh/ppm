import { describe, test, expect } from "bun:test";
import { resolveProtectedPids, type ProtectedPidsInput } from "../../../../src/services/system-metrics/ppm-protected-pids.ts";

function input(over: Partial<ProtectedPidsInput> = {}): ProtectedPidsInput {
  // 600 = a live bun (a real supervisor), 700 = a live ppm binary (a real edge), 500 = notepad (recycled pid).
  const alive = new Set([100, 200, 300, 400, 500, 600, 700]);
  const names = new Map<number, string>([[300, "cloudflared"], [400, "cloudflared"], [500, "notepad"], [600, "bun"], [700, "ppm"]]);
  return {
    status: {},
    selfPid: 100,
    parentPid: 200,
    portTunnelPids: [],
    isAlive: (pid) => alive.has(pid),
    nameOf: (pid) => names.get(pid),
    ...over,
  };
}

describe("resolveProtectedPids", () => {
  test("no status.json → self + live parent", () => {
    const r = resolveProtectedPids(input());
    expect([...r.pids].sort()).toEqual([100, 200]);
    expect([...r.roots].sort()).toEqual([100, 200]);
  });

  test("a live supervisorPid running a PPM image replaces the plain parent as a root", () => {
    const r = resolveProtectedPids(input({ status: { supervisorPid: 600 } }));
    expect([...r.roots].sort()).toEqual([100, 600]);
    expect(r.pids.has(200)).toBe(false);
    expect(r.selfPid).toBe(100);
  });

  test("a stale supervisorPid — dead, or recycled into another image — counts as absent, so the real parent is protected instead", () => {
    for (const stale of [999, 500]) {
      const r = resolveProtectedPids(input({ status: { supervisorPid: stale } }));
      expect(r.pids.has(stale)).toBe(false);
      expect(r.pids.has(200)).toBe(true);
    }
  });

  test("edgePid is protected only while alive AND running a PPM image", () => {
    expect(resolveProtectedPids(input({ status: { edgePid: 700 } })).pids.has(700)).toBe(true);
    expect(resolveProtectedPids(input({ status: { edgePid: 500 } })).pids.has(500)).toBe(false);
    expect(resolveProtectedPids(input({ status: { edgePid: 777 } })).pids.has(777)).toBe(false);
  });

  test("tunnelPid must be alive AND carry the cloudflared image — a recycled pid claiming it gets nothing", () => {
    expect(resolveProtectedPids(input({ status: { tunnelPid: 300 } })).pids.has(300)).toBe(true);
    // 500 is alive but is notepad: the pid was recycled since status.json was written.
    expect(resolveProtectedPids(input({ status: { tunnelPid: 500 } })).pids.has(500)).toBe(false);
    expect(resolveProtectedPids(input({ status: { tunnelPid: 888 } })).pids.has(888)).toBe(false);
  });

  test("per-port preview tunnels are protected under the same cloudflared rule", () => {
    const r = resolveProtectedPids(input({ portTunnelPids: [400, 500, 0, 999] }));
    expect(r.pids.has(400)).toBe(true);
    expect(r.pids.has(500)).toBe(false);
    expect(r.pids.has(999)).toBe(false);
  });

  test("garbage status values are ignored", () => {
    const r = resolveProtectedPids(input({ status: { supervisorPid: "200", edgePid: -1, tunnelPid: 1.5 } }));
    expect([...r.pids].sort()).toEqual([100, 200]);
  });

  test("roots never contain the tunnel or edge — they are protected but not grouping roots", () => {
    const r = resolveProtectedPids(input({ status: { edgePid: 700, tunnelPid: 300 } }));
    expect([...r.roots].sort()).toEqual([100, 200]);
    expect([...r.pids].sort()).toEqual([100, 200, 300, 700]);
  });
});
