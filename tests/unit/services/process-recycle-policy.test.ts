import { describe, expect, it } from "bun:test";
import {
  ACTIVITY_MAX_AGE_MS, DEFAULT_SERVER_RECYCLE_MB, DEFAULT_SUPERVISOR_RECYCLE_MB, RECYCLE_CONFIRM_READINGS,
  RECYCLE_COOLDOWN_MS, RECYCLE_QUIET_MS, decideRecycle, initialRecycleState, quietEnough, serverRecycleLimitMB,
  supervisorRecycleLimitMB, type RecycleLimits, type RecycleReadings, type RecycleState, type ServerActivity,
} from "../../../src/services/process-recycle-policy.ts";

const LIMITS: RecycleLimits = { supervisorMB: 2048, serverMB: 3584 };
const NOW = 10_000_000;
const SERVER = 4242;
const quietReport = (at = NOW, quietSince = NOW - RECYCLE_QUIET_MS - 1): ServerActivity => ({ pid: SERVER, at, busy: false, quietSince });

function run(readings: Partial<RecycleReadings>[], state: RecycleState = initialRecycleState()) {
  let s = state;
  const actions = [];
  for (const r of readings) {
    const out = decideRecycle(s, { now: NOW, serverPid: SERVER, activity: quietReport(), ...r }, LIMITS);
    s = out.state;
    actions.push(out.action);
  }
  return { state: s, actions };
}
const times = <T,>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

describe("recycle limits", () => {
  it("default to 2 GB for the supervisor and 3.5 GB for the server, on Windows only", () => {
    expect(supervisorRecycleLimitMB({}, "win32")).toBe(DEFAULT_SUPERVISOR_RECYCLE_MB);
    expect(serverRecycleLimitMB({}, "win32")).toBe(DEFAULT_SERVER_RECYCLE_MB);
    expect(supervisorRecycleLimitMB({}, "linux")).toBeNull();
    expect(serverRecycleLimitMB({}, "darwin")).toBeNull();
  });

  it("take an override from the env, 0 turning recycling off, and ignore nonsense", () => {
    expect(supervisorRecycleLimitMB({ PPM_SUPERVISOR_RECYCLE_MB: "1024" }, "win32")).toBe(1024);
    expect(serverRecycleLimitMB({ PPM_SERVER_RECYCLE_MB: "0" }, "win32")).toBeNull();
    expect(serverRecycleLimitMB({ PPM_SERVER_RECYCLE_MB: "lots" }, "win32")).toBe(DEFAULT_SERVER_RECYCLE_MB);
    expect(supervisorRecycleLimitMB({ PPM_SUPERVISOR_RECYCLE_MB: "-5" }, "win32")).toBe(DEFAULT_SUPERVISOR_RECYCLE_MB);
  });
});

describe("decideRecycle", () => {
  it("does nothing while both are under their limits", () => {
    const { actions } = run(times(5, { supervisorMB: 900, serverMB: 2000 }));
    expect(actions.every((a) => a.kind === "none")).toBe(true);
  });

  it("restarts the server only after it stays over its limit for several readings in a row", () => {
    const { actions } = run(times(RECYCLE_CONFIRM_READINGS, { supervisorMB: 900, serverMB: 3600 }));
    expect(actions.slice(0, -1).every((a) => a.kind === "none")).toBe(true);
    expect(actions.at(-1)).toMatchObject({ kind: "server" });
    expect((actions.at(-1) as { detail: string }).detail).toContain("3600MB");
  });

  it("forgets a spike: one reading under the limit resets the count", () => {
    const { actions } = run([{ serverMB: 3600 }, { serverMB: 3600 }, { serverMB: 2000 }, { serverMB: 3600 }, { serverMB: 3600 }]);
    expect(actions.every((a) => a.kind === "none")).toBe(true);
  });

  it("replaces the supervisor when it is over, and prefers that when both are (one cut covers both)", () => {
    const { actions } = run(times(RECYCLE_CONFIRM_READINGS, { supervisorMB: 2100, serverMB: 3600 }));
    expect(actions.at(-1)).toMatchObject({ kind: "supervisor" });
  });

  it("waits while something is running, and acts once PPM has been quiet long enough", () => {
    const busy: ServerActivity = { pid: SERVER, at: NOW, busy: true, reasons: ["1 chat(s) working"] };
    const first = run(times(RECYCLE_CONFIRM_READINGS, { serverMB: 3600, activity: busy }));
    expect(first.actions.at(-1)).toEqual({ kind: "wait", target: "server", why: "busy: 1 chat(s) working" });

    const justQuiet = run([{ serverMB: 3600, activity: { pid: SERVER, at: NOW, busy: false, quietSince: NOW - 60_000 } }], first.state);
    expect(justQuiet.actions[0]).toMatchObject({ kind: "wait", why: "quiet for only 60s" });

    const longQuiet = run([{ serverMB: 3600 }], justQuiet.state);
    expect(longQuiet.actions[0]).toMatchObject({ kind: "server" });
  });

  it("never acts on a missing, stale or foreign activity report", () => {
    const over = times(RECYCLE_CONFIRM_READINGS, { serverMB: 3600 });
    const missing = run(over.map((r) => ({ ...r, activity: null })));
    expect(missing.actions.at(-1)).toMatchObject({ kind: "wait", why: "the server has not reported its activity" });
    const stale = run(over.map((r) => ({ ...r, activity: quietReport(NOW - ACTIVITY_MAX_AGE_MS - 1) })));
    expect(stale.actions.at(-1)).toMatchObject({ kind: "wait", why: "the server's activity report is stale" });
    const otherServer = run(over.map((r) => ({ ...r, activity: { ...quietReport(), pid: SERVER + 1 } })));
    expect(otherServer.actions.at(-1)).toMatchObject({ kind: "wait", why: "the server has not reported its activity" });
  });

  it("does not loop: after a recycle it waits out the cooldown", () => {
    const first = run(times(RECYCLE_CONFIRM_READINGS, { serverMB: 3600 }));
    expect(first.actions.at(-1)).toMatchObject({ kind: "server" });
    expect(first.state.lastRecycleAt).toBe(NOW);
    const soon = run(times(RECYCLE_CONFIRM_READINGS, { serverMB: 3600, now: NOW + 60_000 }), first.state);
    expect(soon.actions.at(-1)).toMatchObject({ kind: "wait", why: "a recycle ran less than 30 minutes ago" });
    const later = NOW + RECYCLE_COOLDOWN_MS + 1;
    const after = run(times(RECYCLE_CONFIRM_READINGS, { serverMB: 3600, now: later, activity: quietReport(later, later - RECYCLE_QUIET_MS - 1) }), first.state);
    expect(after.actions.at(-1)).toMatchObject({ kind: "server" });
  });

  it("ignores a process with no reading", () => {
    const { actions } = run(times(5, { supervisorMB: undefined, serverMB: undefined }));
    expect(actions.every((a) => a.kind === "none")).toBe(true);
  });

  it("does nothing for a target whose recycling is off", () => {
    let s = initialRecycleState();
    for (let i = 0; i < 5; i++) {
      const out = decideRecycle(s, { now: NOW, serverPid: SERVER, serverMB: 9000, activity: quietReport() }, { supervisorMB: 2048, serverMB: null });
      s = out.state;
      expect(out.action.kind).toBe("none");
    }
  });
});

describe("quietEnough", () => {
  it("names what is running", () => {
    expect(quietEnough({ pid: 1, at: NOW, busy: true, reasons: ["2 terminal(s) printed in the last 15 min"] }, 1, NOW))
      .toEqual({ ok: false, why: "busy: 2 terminal(s) printed in the last 15 min" });
  });
});
