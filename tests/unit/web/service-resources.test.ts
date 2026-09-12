/**
 * The Services page's live per-unit figures — Mission Center's CPU, Memory,
 * Swap, Drive, GPU and GPU Memory columns, summed over each unit's cgroup.
 *
 * Two rules carry the weight. The key is scope + unit, because `dbus-broker.service`
 * exists in BOTH scopes on an ordinary desktop and one key for the two would
 * publish one figure for two different units. And a RUNNING unit with no rows
 * yet gets an em dash rather than 0: a confident "0%" for something that is
 * running is a wrong reading, where a dash is an honest one.
 */
import { describe, it, expect } from "bun:test";
import {
  IDLE_UNIT, resourcesFor, rollUpByUnit, unitKeyOf,
} from "../../../src/web/components/system/services/service-resources.ts";
import type { ProcessInfo } from "../../../src/types/system-metrics";
import type { ServiceInfo } from "../../../src/types/system-services";

function proc(pid: number, over: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid, ppid: 1, name: "x", command: "x", cpu: 0, ramMB: 0,
    startedAt: 0, ppm: false, protected: false, ...over,
  };
}

function unit(over: Partial<ServiceInfo> = {}): ServiceInfo {
  return {
    unit: "dbus-broker.service", scope: "system", description: "", activeState: "active",
    subState: "running", unitFileState: "enabled", running: true, failed: false,
    enabled: true, mainPid: 1, ...over,
  };
}

describe("rollUpByUnit", () => {
  it("sums CPU, memory and every optional column over a unit's processes", () => {
    const byUnit = rollUpByUnit([
      proc(10, { unitKey: "system:ppm.service", cpu: 1.5, ramMB: 100, swapMB: 2, gpuMemMB: 8 }),
      proc(11, { unitKey: "system:ppm.service", cpu: 0.5, ramMB: 50, swapMB: 1, gpuMemMB: 4 }),
    ]);
    expect(byUnit.get("system:ppm.service")).toEqual({
      count: 2, cpu: 2, ramMB: 150, swapMB: 3, gpuMemMB: 12,
      diskReadBps: undefined, diskWriteBps: undefined, gpuPct: undefined,
    });
  });

  it("keeps the two scopes apart — the same unit name really does exist in both", () => {
    const byUnit = rollUpByUnit([
      proc(10, { unitKey: "system:dbus-broker.service", cpu: 4, ramMB: 20 }),
      proc(11, { unitKey: "user:dbus-broker.service", cpu: 1, ramMB: 5 }),
    ]);
    expect(byUnit.get("system:dbus-broker.service")?.cpu).toBe(4);
    expect(byUnit.get("user:dbus-broker.service")?.cpu).toBe(1);
  });

  it("a row in no unit belongs to no bucket", () => {
    expect(rollUpByUnit([proc(2, { cpu: 9 })]).size).toBe(0);
  });

  it("an unmeasurable column stays undefined rather than collapsing to 0", () => {
    // No process row has a disk figure here, so the column has nothing to say.
    const row = rollUpByUnit([proc(10, { unitKey: "system:a.service", swapMB: 1 })]).get("system:a.service")!;
    expect(row.diskReadBps).toBeUndefined();
    expect(row.swapMB).toBe(1);
  });

  it("one measured member is enough — the others count as 0, not as unknown", () => {
    const row = rollUpByUnit([
      proc(10, { unitKey: "system:a.service", diskReadBps: 4096 }),
      proc(11, { unitKey: "system:a.service" }),
    ]).get("system:a.service")!;
    expect(row.diskReadBps).toBe(4096);
  });

  it("a unit's GPU is capped at 100 — an engine cannot be busier than the interval", () => {
    const row = rollUpByUnit([
      proc(10, { unitKey: "system:a.service", gpuPct: 80 }),
      proc(11, { unitKey: "system:a.service", gpuPct: 70 }),
    ]).get("system:a.service")!;
    expect(row.gpuPct).toBe(100);
  });

  it("float summation is rounded, so a row never reads 2.9000000000000004%", () => {
    const row = rollUpByUnit([
      proc(10, { unitKey: "system:a.service", cpu: 1.1, ramMB: 0.1 }),
      proc(11, { unitKey: "system:a.service", cpu: 1.8, ramMB: 0.2 }),
    ]).get("system:a.service")!;
    expect(row.cpu).toBe(2.9);
    expect(row.ramMB).toBe(0.3);
  });
});

describe("resourcesFor", () => {
  it("a stopped unit with no processes reads zero, which is a real measurement", () => {
    const stopped = unit({ running: false, activeState: "inactive", subState: "dead", mainPid: null });
    expect(resourcesFor(stopped, new Map())).toEqual(IDLE_UNIT);
  });

  it("a RUNNING unit with no rows yet is a dash, never a confident 0%", () => {
    expect(resourcesFor(unit(), new Map())).toBeUndefined();
  });

  it("an ACTIVE unit that owns nothing by construction reads zero, not a dash", () => {
    // `ActiveState` is "active" for all three of these and none of them has a
    // process; going by it put an em dash on 97 of this host's 222 rows.
    for (const subState of ["mounted", "listening", "exited", "waiting", "plugged"]) {
      const owned = unit({ unit: `x.${subState}`, activeState: "active", subState });
      expect(resourcesFor(owned, new Map())).toEqual(IDLE_UNIT);
    }
  });

  it("a LISTENING socket is reported `running` and still owns nothing", () => {
    // `systemctl show -p SubState docker.socket` answers `running` while its
    // MainPID is empty and TasksCurrent is 0 — the processes are in the service
    // the socket activates. Going by SubState alone dashed 14 rows on this host.
    const sock = unit({ unit: "docker.socket", activeState: "active", subState: "running" });
    expect(resourcesFor(sock, new Map())).toEqual(IDLE_UNIT);
    const mount = unit({ unit: "boot.mount", activeState: "active", subState: "running" });
    expect(resourcesFor(mount, new Map())).toEqual(IDLE_UNIT);
  });

  it("a running .service or .scope with no rows is still a dash", () => {
    expect(resourcesFor(unit({ unit: "sshd.service" }), new Map())).toBeUndefined();
    expect(resourcesFor(unit({ unit: "session-2.scope" }), new Map())).toBeUndefined();
  });

  it("no process rows at all (the light tier) means every row is a dash", () => {
    expect(resourcesFor(unit({ running: false }), null)).toBeUndefined();
  });

  it("matches on scope AND unit, so a user row never reads the system unit's figures", () => {
    const byUnit = rollUpByUnit([proc(10, { unitKey: "system:dbus-broker.service", cpu: 4, ramMB: 20 })]);
    expect(resourcesFor(unit({ scope: "system" }), byUnit)?.cpu).toBe(4);
    expect(resourcesFor(unit({ scope: "user" }), byUnit)).toBeUndefined();
  });

  it("the key matches the React key the panel already lists rows under", () => {
    expect(unitKeyOf(unit({ scope: "user", unit: "pipewire.socket" }))).toBe("user:pipewire.socket");
  });
});
