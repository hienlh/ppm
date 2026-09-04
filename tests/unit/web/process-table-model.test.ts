// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/process-table-model.test.ts
import { describe, it, expect } from "bun:test";
import { buildRows, toggleSort } from "../../../src/web/components/system/process-table-model.ts";
import type {
  MetricsHistoryPoint,
  ProcessGroup,
  ProcessInfo,
} from "../../../src/types/system-metrics.ts";

function proc(overrides: Partial<ProcessInfo>): ProcessInfo {
  return {
    pid: 1,
    ppid: 0,
    name: "node",
    command: "node server.js",
    cpu: 0,
    ramMB: 10,
    startedAt: 1000,
    ppm: false,
    protected: false,
    ...overrides,
  };
}

function group(overrides: Partial<ProcessGroup>): ProcessGroup {
  return {
    key: "root:1",
    label: "Node",
    rootPid: 1,
    cpu: 0,
    ramMB: 10,
    count: 1,
    ppm: false,
    pids: [1],
    ...overrides,
  };
}

const EMPTY_HISTORY: MetricsHistoryPoint[] = [];

describe("buildRows — grouped vs flat", () => {
  const processes = [
    proc({ pid: 1, name: "node", cpu: 10, ramMB: 100 }),
    proc({ pid: 2, name: "chrome", cpu: 20, ramMB: 200, ppid: 1 }),
  ];
  const groups = [group({ key: "root:1", label: "Node", pids: [1, 2], cpu: 30, ramMB: 300, count: 2 })];

  it("grouped mode: one row per group, children only when expanded", () => {
    const collapsed = buildRows({
      processes, groups, history: EMPTY_HISTORY, mode: "grouped",
      ppmOnly: false, query: "", sortKey: null, sortDir: "desc", expanded: new Set(),
    });
    expect(collapsed.rows).toHaveLength(1);
    expect(collapsed.rows[0]!.kind).toBe("group");

    const expanded = buildRows({
      processes, groups, history: EMPTY_HISTORY, mode: "grouped",
      ppmOnly: false, query: "", sortKey: null, sortDir: "desc", expanded: new Set(["root:1"]),
    });
    expect(expanded.rows).toHaveLength(3);
    expect(expanded.rows[1]!.kind).toBe("process");
    expect(expanded.rows[2]!.kind).toBe("process");
  });

  it("flat mode: every process, one row, no grouping", () => {
    const result = buildRows({
      processes, groups, history: EMPTY_HISTORY, mode: "flat",
      ppmOnly: false, query: "", sortKey: null, sortDir: "desc", expanded: new Set(),
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.kind === "process")).toBe(true);
  });
});

describe("buildRows — ppmOnly filter", () => {
  it("flat: keeps only ppm-owned processes", () => {
    const processes = [
      proc({ pid: 1, ppm: true }),
      proc({ pid: 2, ppm: false }),
    ];
    const result = buildRows({
      processes, groups: [], history: EMPTY_HISTORY, mode: "flat",
      ppmOnly: true, query: "", sortKey: null, sortDir: "desc", expanded: new Set(),
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ kind: "process", proc: { pid: 1 } });
  });

  it("grouped: keeps only ppm-owned groups", () => {
    const groups = [
      group({ key: "root:1", ppm: true }),
      group({ key: "root:2", ppm: false, pids: [2] }),
    ];
    const processes = [proc({ pid: 1 }), proc({ pid: 2 })];
    const result = buildRows({
      processes, groups, history: EMPTY_HISTORY, mode: "grouped",
      ppmOnly: true, query: "", sortKey: null, sortDir: "desc", expanded: new Set(),
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ kind: "group", group: { key: "root:1" } });
  });
});

describe("buildRows — search", () => {
  const processes = [
    proc({ pid: 1, name: "node", command: "node server.js" }),
    proc({ pid: 2, name: "chrome", command: "chrome.exe --tab", ppid: 1 }),
  ];
  const groups = [group({ key: "root:1", label: "Node", pids: [1, 2] })];

  it("matches a child but not the group label — group survives and auto-expands", () => {
    const result = buildRows({
      processes, groups, history: EMPTY_HISTORY, mode: "grouped",
      ppmOnly: false, query: "chrome", sortKey: null, sortDir: "desc", expanded: new Set(),
    });
    expect(result.rows).toHaveLength(2); // group + the matching child only
    expect(result.rows[0]).toMatchObject({ kind: "group", expanded: true });
    expect(result.autoExpanded.has("root:1")).toBe(true);
    const child = result.rows[1];
    expect(child?.kind).toBe("process");
    if (child?.kind === "process") expect(child.proc.pid).toBe(2);
  });

  it("no match drops the group entirely", () => {
    const result = buildRows({
      processes, groups, history: EMPTY_HISTORY, mode: "grouped",
      ppmOnly: false, query: "nonexistent", sortKey: null, sortDir: "desc", expanded: new Set(),
    });
    expect(result.rows).toHaveLength(0);
  });

  it("clearing the query does not persist auto-expansion into the `expanded` set", () => {
    buildRows({
      processes, groups, history: EMPTY_HISTORY, mode: "grouped",
      ppmOnly: false, query: "chrome", sortKey: null, sortDir: "desc", expanded: new Set(),
    });
    const cleared = buildRows({
      processes, groups, history: EMPTY_HISTORY, mode: "grouped",
      ppmOnly: false, query: "", sortKey: null, sortDir: "desc", expanded: new Set(),
    });
    expect(cleared.rows).toHaveLength(1); // back to collapsed
  });
});

describe("buildRows — sort", () => {
  it("three-state toggle: desc -> asc -> off", () => {
    expect(toggleSort(null, "desc", "cpu")).toEqual(["cpu", "desc"]);
    expect(toggleSort("cpu", "desc", "cpu")).toEqual(["cpu", "asc"]);
    expect(toggleSort("cpu", "asc", "cpu")).toEqual([null, "desc"]);
  });

  it("sorts groups by cpu desc", () => {
    const groups = [
      group({ key: "a", cpu: 5, pids: [] }),
      group({ key: "b", cpu: 50, pids: [] }),
    ];
    const result = buildRows({
      processes: [], groups, history: EMPTY_HISTORY, mode: "grouped",
      ppmOnly: false, query: "", sortKey: "cpu", sortDir: "desc", expanded: new Set(),
    });
    expect(result.rows.map((r) => (r.kind === "group" ? r.group.key : null))).toEqual(["b", "a"]);
  });

  it("sorts flat processes by name asc", () => {
    const processes = [proc({ pid: 1, name: "zsh" }), proc({ pid: 2, name: "bash" })];
    const result = buildRows({
      processes, groups: [], history: EMPTY_HISTORY, mode: "flat",
      ppmOnly: false, query: "", sortKey: "name", sortDir: "asc", expanded: new Set(),
    });
    expect(result.rows.map((r) => (r.kind === "process" ? r.proc.name : null))).toEqual(["bash", "zsh"]);
  });
});

describe("buildRows — sort by optional metric columns (disk/gpu/gpuMem/net)", () => {
  function names(result: ReturnType<typeof buildRows>): (string | null)[] {
    return result.rows.map((r) => (r.kind === "process" ? r.proc.name : null));
  }

  it("disk sorts by read + write, desc", () => {
    const processes = [
      proc({ pid: 1, name: "a", diskReadBps: 100, diskWriteBps: 0 }),
      proc({ pid: 2, name: "b", diskReadBps: 10, diskWriteBps: 500 }),
      proc({ pid: 3, name: "c", diskReadBps: 1, diskWriteBps: 1 }),
    ];
    const result = buildRows({
      processes, groups: [], history: EMPTY_HISTORY, mode: "flat",
      ppmOnly: false, query: "", sortKey: "disk", sortDir: "desc", expanded: new Set(),
    });
    expect(names(result)).toEqual(["b", "a", "c"]);
  });

  it("net sorts by in + out", () => {
    const processes = [
      proc({ pid: 1, name: "a", netInBps: 5, netOutBps: 5 }),
      proc({ pid: 2, name: "b", netInBps: 100, netOutBps: 0 }),
    ];
    const result = buildRows({
      processes, groups: [], history: EMPTY_HISTORY, mode: "flat",
      ppmOnly: false, query: "", sortKey: "net", sortDir: "desc", expanded: new Set(),
    });
    expect(names(result)).toEqual(["b", "a"]);
  });

  it("gpu sorts by gpuPct directly", () => {
    const processes = [
      proc({ pid: 1, name: "a", gpuPct: 5 }),
      proc({ pid: 2, name: "b", gpuPct: 40 }),
    ];
    const result = buildRows({
      processes, groups: [], history: EMPTY_HISTORY, mode: "flat",
      ppmOnly: false, query: "", sortKey: "gpu", sortDir: "desc", expanded: new Set(),
    });
    expect(names(result)).toEqual(["b", "a"]);
  });

  it("gpuMem sorts by gpuMemMB directly", () => {
    const processes = [
      proc({ pid: 1, name: "a", gpuMemMB: 100 }),
      proc({ pid: 2, name: "b", gpuMemMB: 2000 }),
    ];
    const result = buildRows({
      processes, groups: [], history: EMPTY_HISTORY, mode: "flat",
      ppmOnly: false, query: "", sortKey: "gpuMem", sortDir: "asc", expanded: new Set(),
    });
    expect(names(result)).toEqual(["a", "b"]);
  });

  it("undefined sorts last regardless of direction (desc)", () => {
    const processes = [
      proc({ pid: 1, name: "measured", diskReadBps: 10, diskWriteBps: 0 }),
      proc({ pid: 2, name: "unmeasured" }), // diskReadBps/diskWriteBps both undefined
    ];
    const result = buildRows({
      processes, groups: [], history: EMPTY_HISTORY, mode: "flat",
      ppmOnly: false, query: "", sortKey: "disk", sortDir: "desc", expanded: new Set(),
    });
    expect(names(result)).toEqual(["measured", "unmeasured"]);
  });

  it("undefined sorts last regardless of direction (asc)", () => {
    const processes = [
      proc({ pid: 1, name: "unmeasured" }),
      proc({ pid: 2, name: "measured", gpuPct: 1 }),
    ];
    const result = buildRows({
      processes, groups: [], history: EMPTY_HISTORY, mode: "flat",
      ppmOnly: false, query: "", sortKey: "gpu", sortDir: "asc", expanded: new Set(),
    });
    expect(names(result)).toEqual(["measured", "unmeasured"]);
  });

  it("both sides undefined keeps stable relative order (no throw)", () => {
    const processes = [
      proc({ pid: 1, name: "a" }),
      proc({ pid: 2, name: "b" }),
    ];
    expect(() =>
      buildRows({
        processes, groups: [], history: EMPTY_HISTORY, mode: "flat",
        ppmOnly: false, query: "", sortKey: "net", sortDir: "desc", expanded: new Set(),
      }),
    ).not.toThrow();
  });

  it("group roll-ups sort by the same optional-metric rules", () => {
    const groups = [
      group({ key: "a", pids: [], diskReadBps: 5, diskWriteBps: 0 }),
      group({ key: "b", pids: [], diskReadBps: 50, diskWriteBps: 0 }),
      group({ key: "c", pids: [] }), // undefined — sorts last
    ];
    const result = buildRows({
      processes: [], groups, history: EMPTY_HISTORY, mode: "grouped",
      ppmOnly: false, query: "", sortKey: "disk", sortDir: "desc", expanded: new Set(),
    });
    expect(result.rows.map((r) => (r.kind === "group" ? r.group.key : null))).toEqual(["b", "a", "c"]);
  });
});

describe("buildRows — totals", () => {
  it("sums cpu/ram/count across visible groups", () => {
    const groups = [
      group({ key: "a", cpu: 10, ramMB: 100, count: 2, pids: [] }),
      group({ key: "b", cpu: 5, ramMB: 50, count: 1, pids: [] }),
    ];
    const result = buildRows({
      processes: [], groups, history: EMPTY_HISTORY, mode: "grouped",
      ppmOnly: false, query: "", sortKey: null, sortDir: "desc", expanded: new Set(),
    });
    expect(result.totals).toMatchObject({ cpu: 15, ramMB: 150, count: 3 });
  });

  it("sums optional metrics only over rows that measured them", () => {
    const processes = [
      proc({ pid: 1, diskReadBps: 100, diskWriteBps: 50, gpuMemMB: 200 }),
      proc({ pid: 2 }), // no optional metrics at all
      proc({ pid: 3, diskReadBps: 10, diskWriteBps: 0, gpuMemMB: 300 }),
    ];
    const result = buildRows({
      processes, groups: [], history: EMPTY_HISTORY, mode: "flat",
      ppmOnly: false, query: "", sortKey: null, sortDir: "desc", expanded: new Set(),
    });
    expect(result.totals.diskReadBps).toBe(110);
    expect(result.totals.diskWriteBps).toBe(50);
    expect(result.totals.gpuMemMB).toBe(500);
    expect(result.totals.netInBps).toBeUndefined();
    expect(result.totals.netOutBps).toBeUndefined();
  });

  it("an optional metric total is undefined when no row measured it at all", () => {
    const processes = [proc({ pid: 1 }), proc({ pid: 2 })];
    const result = buildRows({
      processes, groups: [], history: EMPTY_HISTORY, mode: "flat",
      ppmOnly: false, query: "", sortKey: null, sortDir: "desc", expanded: new Set(),
    });
    expect(result.totals.diskReadBps).toBeUndefined();
    expect(result.totals.gpuMemMB).toBeUndefined();
  });
});

describe("buildRows — missing pid race", () => {
  it("a group referencing a pid absent from processes[] does not throw and skips it", () => {
    const groups = [group({ key: "root:1", pids: [1, 999] })];
    const processes = [proc({ pid: 1 })]; // pid 999 has already exited
    expect(() =>
      buildRows({
        processes, groups, history: EMPTY_HISTORY, mode: "grouped",
        ppmOnly: false, query: "", sortKey: null, sortDir: "desc", expanded: new Set(["root:1"]),
      }),
    ).not.toThrow();
    const result = buildRows({
      processes, groups, history: EMPTY_HISTORY, mode: "grouped",
      ppmOnly: false, query: "", sortKey: null, sortDir: "desc", expanded: new Set(["root:1"]),
    });
    expect(result.rows).toHaveLength(2); // group + the one resolvable child
  });
});

describe("buildRows — group sparkline", () => {
  it("reads the last 60 history points for the group's key", () => {
    const history: MetricsHistoryPoint[] = [
      { ts: 1, system: {} as never, groups: { "root:1": { cpu: 5, ramMB: 10 } } },
      { ts: 2, system: {} as never, groups: { "root:1": { cpu: 15, ramMB: 20 } } },
    ];
    const groups = [group({ key: "root:1", pids: [] })];
    const result = buildRows({
      processes: [], groups, history, mode: "grouped",
      ppmOnly: false, query: "", sortKey: null, sortDir: "desc", expanded: new Set(),
    });
    const row = result.rows[0];
    expect(row?.kind).toBe("group");
    if (row?.kind === "group") expect(row.spark).toEqual([5, 15]);
  });
});
