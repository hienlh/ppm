import { describe, test, expect } from "bun:test";
import {
  buildAppRows, subtreePids, childIndex, sortAppRows, filterAppRows,
} from "../../../src/web/components/system/apps/app-rows";
import type { AppInfo, ProcessInfo } from "../../../src/types/system-metrics";

const proc = (pid: number, ppid: number, over: Partial<ProcessInfo> = {}): ProcessInfo => ({
  pid, ppid, name: `p${pid}`, command: `p${pid}`, cpu: 1, ramMB: 100,
  startedAt: 0, ppm: false, protected: false, ...over,
});

const app = (id: string, pids: number[], over: Partial<AppInfo> = {}): AppInfo =>
  ({ id, name: id.toUpperCase(), icon: `${id}-icon`, pids, ...over });

describe("subtreePids", () => {
  test("collects the whole tree under each root", () => {
    const children = childIndex([proc(1, 0), proc(2, 1), proc(3, 2), proc(4, 1), proc(9, 0)]);
    expect(subtreePids([1], children).sort()).toEqual([1, 2, 3, 4]);
  });

  test("a pid reachable from two roots is counted once", () => {
    const children = childIndex([proc(1, 0), proc(2, 0), proc(3, 1)]);
    expect(subtreePids([1, 3], children).sort()).toEqual([1, 3]);
  });

  test("a parent chain that loops terminates instead of blowing the stack", () => {
    // A reparent observed mid-walk can produce exactly this.
    const children = childIndex([proc(1, 2), proc(2, 1)]);
    expect(subtreePids([1], children).sort()).toEqual([1, 2]);
  });
});

describe("buildAppRows", () => {
  const processes = [
    proc(100, 1, { cpu: 2, ramMB: 500 }),
    proc(101, 100, { cpu: 3, ramMB: 250 }),
    proc(102, 101, { cpu: 0.5, ramMB: 250 }),
    proc(200, 1, { cpu: 10, ramMB: 1000 }),
  ];

  test("figures sum over the whole subtree, not just the root the server named", () => {
    const rows = buildAppRows([app("code", [100])], processes);
    expect(rows[0]).toMatchObject({
      id: "code", name: "CODE", icon: "code-icon", pids: [100],
      processCount: 3, cpu: 5.5, ramMB: 1000,
    });
  });

  test("every subtree member is listed, so ending the app ends the helpers too", () => {
    const rows = buildAppRows([app("code", [100])], processes);
    expect(rows[0]?.memberPids.sort()).toEqual([100, 101, 102]);
    // The roots the server named stay separate: they are what the row displays.
    expect(rows[0]?.pids).toEqual([100]);
  });

  test("an app whose processes have all exited is dropped, not shown as zeros", () => {
    expect(buildAppRows([app("gone", [999])], processes)).toEqual([]);
  });

  test("an optional column is undefined unless some member measured it", () => {
    const withDisk = [proc(100, 1, { diskReadBps: 10 }), proc(101, 100, {})];
    const rows = buildAppRows([app("a", [100])], withDisk);
    expect(rows[0]?.diskReadBps).toBe(10);
    expect(rows[0]?.gpuPct).toBeUndefined();
    expect(rows[0]?.diskWriteBps).toBeUndefined();
  });

  test("summed GPU busy is clamped, as it is for a process group", () => {
    const busy = [proc(100, 1, { gpuPct: 80 }), proc(101, 100, { gpuPct: 70 })];
    expect(buildAppRows([app("a", [100])], busy)[0]?.gpuPct).toBe(100);
  });

  test("two apps are independent, and a shared ancestor is not double counted", () => {
    const rows = buildAppRows([app("a", [100]), app("b", [200])], processes);
    expect(rows.map((r) => r.cpu)).toEqual([5.5, 10]);
  });
});

describe("sortAppRows", () => {
  const rows = buildAppRows(
    [app("b", [1]), app("a", [2]), app("c", [3])],
    [proc(1, 0, { cpu: 5, ramMB: 100 }), proc(2, 0, { cpu: 5, ramMB: 300 }), proc(3, 0, { cpu: 9, ramMB: 200 })],
  );

  test("busiest first, with the name breaking ties so the order does not churn", () => {
    expect(sortAppRows(rows, "cpu", "desc").map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  test("every key sorts both ways", () => {
    expect(sortAppRows(rows, "ram", "desc").map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(sortAppRows(rows, "name", "asc").map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(sortAppRows(rows, "name", "desc").map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  test("the input is not mutated", () => {
    const before = rows.map((r) => r.id);
    sortAppRows(rows, "cpu", "asc");
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe("filterAppRows", () => {
  const rows = buildAppRows([app("code", [1]), app("vlc", [2])], [proc(1, 0), proc(2, 0)]);

  test("matches the display name, case-insensitively", () => {
    expect(filterAppRows(rows, "CO").map((r) => r.id)).toEqual(["code"]);
    expect(filterAppRows(rows, "  ").map((r) => r.id)).toEqual(["code", "vlc"]);
    expect(filterAppRows(rows, "zzz")).toEqual([]);
  });
});
