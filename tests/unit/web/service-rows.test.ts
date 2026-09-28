import { describe, test, expect } from "bun:test";
import {
  shapeServices, compareServices, matchesFilter, matchesQuery, serviceCounts,
  serviceTone, serviceStatusText, hasAnyAction,
} from "../../../src/web/components/system/services/service-rows";
import type { ServiceInfo } from "../../../src/types/system-services";
import { SERVICE_ACTIONS } from "../../../src/types/system-services";

const svc = (unit: string, over: Partial<ServiceInfo> = {}): ServiceInfo => ({
  unit, scope: "system", description: "", activeState: "inactive", subState: "dead",
  unitFileState: "disabled", running: false, failed: false, enabled: false, mainPid: null, ...over,
});

const RUNNING = { activeState: "active", subState: "running", running: true };
const FAILED = { activeState: "failed", subState: "failed", failed: true };

describe("filtering", () => {
  test("each filter selects exactly its own band", () => {
    const running = svc("a.service", RUNNING);
    const failed = svc("b.service", FAILED);
    const enabled = svc("c.service", { enabled: true });
    expect(matchesFilter(running, "running")).toBe(true);
    expect(matchesFilter(running, "failed")).toBe(false);
    expect(matchesFilter(failed, "failed")).toBe(true);
    expect(matchesFilter(enabled, "enabled")).toBe(true);
    expect(matchesFilter(enabled, "all")).toBe(true);
  });

  test("search covers the description, which is where a user looks for a friendly name", () => {
    const bluez = svc("bluez.service", { description: "Bluetooth service" });
    expect(matchesQuery(bluez, "bluetooth")).toBe(true);
    expect(matchesQuery(bluez, "BLUEZ")).toBe(true);
    expect(matchesQuery(bluez, "   ")).toBe(true);
    expect(matchesQuery(bluez, "ssh")).toBe(false);
  });
});

describe("ordering", () => {
  test("failed first, then running, then the rest — alphabetical within each", () => {
    const list = [
      svc("z-idle.service"),
      svc("m-running.service", RUNNING),
      svc("a-idle.service"),
      svc("q-failed.service", FAILED),
      svc("b-running.service", RUNNING),
    ];
    expect([...list].sort(compareServices).map((s) => s.unit)).toEqual([
      "q-failed.service", "b-running.service", "m-running.service", "a-idle.service", "z-idle.service",
    ]);
  });
});

describe("shapeServices", () => {
  const list = [
    svc("sys-a.service", RUNNING),
    svc("sys-b.service", FAILED),
    svc("user-a.service", { scope: "user", ...RUNNING }),
  ];

  test("one scope at a time, because a user unit and a system unit are not the same unit", () => {
    expect(shapeServices(list, "system", "all", "").map((s) => s.unit)).toEqual(["sys-b.service", "sys-a.service"]);
    expect(shapeServices(list, "user", "all", "").map((s) => s.unit)).toEqual(["user-a.service"]);
  });

  test("filter and query apply together", () => {
    expect(shapeServices(list, "system", "running", "").map((s) => s.unit)).toEqual(["sys-a.service"]);
    expect(shapeServices(list, "system", "all", "sys-b").map((s) => s.unit)).toEqual(["sys-b.service"]);
    expect(shapeServices(list, "system", "failed", "sys-a")).toEqual([]);
  });
});

describe("serviceCounts", () => {
  const list = [svc("a.service", RUNNING), svc("b.service", FAILED), svc("c.service", { scope: "user", ...RUNNING })];

  test("counts the whole list, or one scope of it", () => {
    expect(serviceCounts(list)).toEqual({ total: 3, running: 2, failed: 1 });
    expect(serviceCounts(list, "user")).toEqual({ total: 1, running: 1, failed: 0 });
  });
});

describe("row presentation", () => {
  test("activating is its own tone, not borrowed from running or failed", () => {
    expect(serviceTone(svc("a.service", RUNNING))).toBe("running");
    expect(serviceTone(svc("a.service", FAILED))).toBe("failed");
    expect(serviceTone(svc("a.service", { activeState: "activating", subState: "start" }))).toBe("busy");
    expect(serviceTone(svc("a.service"))).toBe("idle");
  });

  test("the status line names both systemd states and the unit-file one", () => {
    expect(serviceStatusText(svc("a.service", RUNNING))).toBe("active (running) · disabled");
    expect(serviceStatusText(svc("a.service", { unitFileState: null }))).toBe("inactive (dead)");
  });

  test("a unit with every action refused offers no menu at all", () => {
    const refused = Object.fromEntries(SERVICE_ACTIONS.map((a) => [a, "no"]));
    expect(hasAnyAction(svc("a.service"), SERVICE_ACTIONS)).toBe(true);
    expect(hasAnyAction(svc("a.service", { refused }), SERVICE_ACTIONS)).toBe(false);
    expect(hasAnyAction(svc("a.service", { refused: { stop: "no" } }), SERVICE_ACTIONS)).toBe(true);
  });
});
