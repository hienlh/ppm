import { describe, expect, it } from "bun:test";
import {
  checkDue, classifyChildCheck, MAX_ALERTS_PER_HANDOFF, shouldAlert, type ChildObservation,
} from "../../../../../src/services/ppm-tasks/child-check/child-check-classifier.ts";

const MIN = 60_000;
const N = 30 * MIN;
const base: ChildObservation = {
  exists: true, card: false, running: true, lastProgressAt: null, lastActivityAt: null, handedOffAt: 0, now: 0, intervalMs: N,
};
const obs = (o: Partial<ChildObservation>): ChildObservation => ({ ...base, ...o });

describe("classifyChildCheck", () => {
  it("a card on screen is waiting_card, whatever else", () => {
    expect(classifyChildCheck(obs({ card: true, now: 5 * N })).state).toBe("waiting_card");
  });

  it("a running turn is running until an interval passes without progress, then stalled", () => {
    expect(classifyChildCheck(obs({ lastProgressAt: 10 * MIN, now: 39 * MIN })).state).toBe("running");
    const v = classifyChildCheck(obs({ lastProgressAt: 10 * MIN, now: 40 * MIN }));
    expect(v).toEqual({ state: "stalled", since: 10 * MIN, reason: "no new output" });
  });

  it("an idle chat that worked after the hand-off is finished_no_report 5 minutes after its last write", () => {
    expect(classifyChildCheck(obs({ running: false, lastActivityAt: 10 * MIN, now: 14 * MIN })).state).toBe("running");
    expect(classifyChildCheck(obs({ running: false, lastActivityAt: 10 * MIN, now: 15 * MIN })).state).toBe("finished_no_report");
  });

  it("a chat that never started is finished_no_report after one interval", () => {
    expect(classifyChildCheck(obs({ running: false, lastActivityAt: -5 * MIN, now: 29 * MIN })).state).toBe("running");
    expect(classifyChildCheck(obs({ running: false, lastActivityAt: null, now: 30 * MIN })))
      .toEqual({ state: "finished_no_report", since: 0, reason: "never started on the task" });
  });

  it("a deleted chat is finished_no_report with its reason", () => {
    expect(classifyChildCheck(obs({ exists: false, now: MIN })).reason).toBe("session no longer exists");
  });
});

describe("shouldAlert", () => {
  const stalled = { state: "stalled" as const, since: 0, reason: "" };
  const none = { alerts: 0, lastAlertAt: null, lastAlertState: null };

  it("never alerts running or waiting_card", () => {
    expect(shouldAlert({ ...stalled, state: "running" }, none, N, N)).toBe(false);
    expect(shouldAlert({ ...stalled, state: "waiting_card" }, none, N, N)).toBe(false);
  });

  it("alerts when a state starts, again after 3 intervals, then stays silent", () => {
    expect(shouldAlert(stalled, none, N, N)).toBe(true);
    const once = { alerts: 1, lastAlertAt: N, lastAlertState: "stalled" as const };
    expect(shouldAlert(stalled, once, 2 * N, N)).toBe(false);
    expect(shouldAlert(stalled, once, 3 * N, N)).toBe(true);
    const twice = { alerts: 2, lastAlertAt: 3 * N, lastAlertState: "stalled" as const };
    expect(shouldAlert(stalled, twice, 10 * N, N)).toBe(false);
  });

  it("alerts again when the state changes or progress resumed and stopped again", () => {
    const twice = { alerts: 2, lastAlertAt: 3 * N, lastAlertState: "stalled" as const };
    expect(shouldAlert({ ...stalled, state: "finished_no_report" }, twice, 4 * N, N)).toBe(true);
    expect(shouldAlert({ ...stalled, since: 4 * N }, twice, 5 * N, N)).toBe(true);
  });

  it("stops at four alerts per hand-off", () => {
    expect(shouldAlert({ ...stalled, since: 9 * N }, { alerts: MAX_ALERTS_PER_HANDOFF, lastAlertAt: 3 * N, lastAlertState: "stalled" }, 10 * N, N)).toBe(false);
  });
});

describe("checkDue", () => {
  it("first looks one interval after the hand-off", () => {
    expect(checkDue(null, 0, N - 1, N)).toBe(false);
    expect(checkDue(null, 0, N, N)).toBe(true);
  });

  it("looks again an interval after the last check, or when a running child reaches an interval without progress", () => {
    const running = { state: "running" as const, checkedAt: N, lastProgressAt: 20 * MIN, alerts: 0, lastAlertAt: null, lastAlertState: null };
    expect(checkDue(running, 0, 49 * MIN, N)).toBe(false);
    expect(checkDue(running, 0, 50 * MIN, N)).toBe(true);
  });

  it("looks again when a repeat alert falls due", () => {
    const stalled = { state: "stalled" as const, checkedAt: 80 * MIN, lastProgressAt: 0, alerts: 1, lastAlertAt: N, lastAlertState: "stalled" as const };
    expect(checkDue(stalled, 0, 89 * MIN, N)).toBe(false);
    expect(checkDue(stalled, 0, 90 * MIN, N)).toBe(true);
  });
});
