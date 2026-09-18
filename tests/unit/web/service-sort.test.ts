/**
 * Sorting the Services table by its columns.
 *
 * The rule worth pinning is the one that is invisible in a screenshot: a unit
 * whose figures were **not measured** sorts last in *either* direction, while a
 * unit that owns no processes sorts as the real zero it is. Those two render
 * differently (an em dash against "0 MB") and they are different claims — "this
 * tick carried no process rows" against "this unit is using nothing" — so an
 * ascending sort that puts the dashes on top would be reading absence as the
 * smallest value.
 *
 * The tie-break matters as much: the list is rebuilt from a fresh array on every
 * 2 s tick, and on this host a hundred-odd units all read 0%. Without a stable
 * second key they would trade places on every tick.
 */
import { describe, test, expect } from "bun:test";
import { sortServiceRows, sortValueOf, type ServiceListRow } from "../../../src/web/components/system/services/service-sort.ts";
import { IDLE_UNIT, type UnitResources } from "../../../src/web/components/system/services/service-resources.ts";
import type { ServiceInfo } from "../../../src/types/system-services";

function unit(name: string, over: Partial<ServiceInfo> = {}): ServiceInfo {
  return {
    unit: name,
    scope: "system",
    description: "",
    activeState: "active",
    subState: "running",
    unitFileState: "enabled",
    running: true,
    failed: false,
    enabled: true,
    mainPid: 100,
    ...over,
  };
}

function row(name: string, resources?: UnitResources, over: Partial<ServiceInfo> = {}): ServiceListRow {
  return { service: unit(name, over), resources };
}

/** A measured roll-up; every field present so one test can vary one field. */
function res(over: Partial<UnitResources> = {}): UnitResources {
  return {
    count: 1, cpu: 0, ramMB: 0, swapMB: 0,
    diskReadBps: 0, diskWriteBps: 0, gpuPct: 0, gpuMemMB: 0,
    ...over,
  };
}

const names = (rows: ServiceListRow[]) => rows.map((r) => r.service.unit);

describe("the default order is still reachable", () => {
  test("a null key is the page's own banding: failed, then running, then the rest", () => {
    const rows = [
      row("zzz-running.service", res()),
      row("aaa-idle.service", res(), { running: false, activeState: "inactive" }),
      row("mmm-failed.service", res(), { failed: true, running: false, activeState: "failed" }),
    ];
    expect(names(sortServiceRows(rows, null, "desc"))).toEqual([
      "mmm-failed.service", "zzz-running.service", "aaa-idle.service",
    ]);
  });

  test("the direction is ignored for the default — it is not a column", () => {
    const rows = [row("b.service", res()), row("a.service", res())];
    expect(names(sortServiceRows(rows, null, "asc"))).toEqual(names(sortServiceRows(rows, null, "desc")));
  });
});

describe("name", () => {
  test("sorts alphabetically, ignoring the failed/running banding", () => {
    const rows = [
      row("c.service", res()),
      row("a.service", res(), { failed: true }),
      row("b.service", res()),
    ];
    expect(names(sortServiceRows(rows, "name", "asc"))).toEqual(["a.service", "b.service", "c.service"]);
    expect(names(sortServiceRows(rows, "name", "desc"))).toEqual(["c.service", "b.service", "a.service"]);
  });
});

describe("pid", () => {
  test("a unit with no main process is not a unit with pid 0", () => {
    const rows = [
      row("none.service", res(), { mainPid: null }),
      row("low.service", res(), { mainPid: 2 }),
      row("high.service", res(), { mainPid: 900 }),
    ];
    expect(names(sortServiceRows(rows, "pid", "desc"))).toEqual(["high.service", "low.service", "none.service"]);
    // Still last ascending: absence is not the smallest pid.
    expect(names(sortServiceRows(rows, "pid", "asc"))).toEqual(["low.service", "high.service", "none.service"]);
  });
});

describe("the metric columns", () => {
  const cases: { key: "cpu" | "ram" | "swap" | "gpu" | "gpuMem"; field: keyof UnitResources }[] = [
    { key: "cpu", field: "cpu" },
    { key: "ram", field: "ramMB" },
    { key: "swap", field: "swapMB" },
    { key: "gpu", field: "gpuPct" },
    { key: "gpuMem", field: "gpuMemMB" },
  ];

  for (const { key, field } of cases) {
    test(`${key} orders by ${String(field)} both ways`, () => {
      const rows = [
        row("small.service", res({ [field]: 1 })),
        row("big.service", res({ [field]: 9 })),
        row("mid.service", res({ [field]: 5 })),
      ];
      expect(names(sortServiceRows(rows, key, "desc"))).toEqual(["big.service", "mid.service", "small.service"]);
      expect(names(sortServiceRows(rows, key, "asc"))).toEqual(["small.service", "mid.service", "big.service"]);
    });

    test(`${key}: an unmeasured row sorts last in either direction`, () => {
      const rows = [
        row("unmeasured.service", undefined),
        row("busy.service", res({ [field]: 7 })),
        row("zero.service", res({ [field]: 0 })),
      ];
      expect(names(sortServiceRows(rows, key, "desc"))).toEqual([
        "busy.service", "zero.service", "unmeasured.service",
      ]);
      expect(names(sortServiceRows(rows, key, "asc"))).toEqual([
        "zero.service", "busy.service", "unmeasured.service",
      ]);
    });
  }

  test("a unit that owns nothing is a real zero, not an absent reading", () => {
    // `IDLE_UNIT` is what a socket or a finished oneshot gets. It must sort
    // among the numbers, above the rows that could not be measured at all.
    const rows = [
      row("unmeasured.service", undefined),
      row("idle.socket", IDLE_UNIT),
      row("busy.service", res({ ramMB: 1 })),
    ];
    expect(names(sortServiceRows(rows, "ram", "asc"))).toEqual([
      "idle.socket", "busy.service", "unmeasured.service",
    ]);
  });
});

describe("drive", () => {
  test("ranks on read and write together, as the cell shows them", () => {
    const rows = [
      row("reader.service", res({ diskReadBps: 100, diskWriteBps: 0 })),
      row("writer.service", res({ diskReadBps: 0, diskWriteBps: 250 })),
      row("both.service", res({ diskReadBps: 80, diskWriteBps: 80 })),
    ];
    expect(names(sortServiceRows(rows, "disk", "desc"))).toEqual([
      "writer.service", "both.service", "reader.service",
    ]);
  });

  test("one measured half is still a reading; neither is not", () => {
    expect(sortValueOf(row("a.service", res({ diskReadBps: 5, diskWriteBps: undefined })), "disk")).toBe(5);
    expect(sortValueOf(row("b.service", res({ diskReadBps: undefined, diskWriteBps: undefined })), "disk"))
      .toBeUndefined();
  });
});

describe("the order is deterministic", () => {
  test("ties break on the unit name, so a tick cannot reshuffle the list", () => {
    const rows = [row("c.service", res()), row("a.service", res()), row("b.service", res())];
    for (const dir of ["asc", "desc"] as const) {
      expect(names(sortServiceRows(rows, "cpu", dir))).toEqual(["a.service", "b.service", "c.service"]);
    }
  });

  test("rows that are all unmeasured still come back in a fixed order", () => {
    const rows = [row("c.service"), row("a.service"), row("b.service")];
    expect(names(sortServiceRows(rows, "gpu", "desc"))).toEqual(["a.service", "b.service", "c.service"]);
  });

  test("the input array is not mutated — it is the memoised list upstream", () => {
    const rows = [row("b.service", res({ cpu: 1 })), row("a.service", res({ cpu: 9 }))];
    const before = names(rows);
    sortServiceRows(rows, "cpu", "desc");
    expect(names(rows)).toEqual(before);
  });
});
