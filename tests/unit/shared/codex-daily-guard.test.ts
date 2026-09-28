import { describe, expect, it } from "bun:test";
import { dailyGuardState } from "../../../src/shared/codex-daily-guard.ts";

const DAY = 24 * 60 * 60 * 1000;
const reset = new Date("2026-09-22T00:00:00.000Z").toISOString();

function weekly(utilization: number) {
  return { utilization, resetsAt: reset, resetsInMinutes: null, resetsInHours: null, windowHours: 168 };
}

describe("Codex daily guard", () => {
  it("opens one fifth at the exact start of a weekday window", () => {
    const state = dailyGuardState(weekly(0.14), new Date(reset).getTime() - 7 * DAY + 1);
    expect(state).toMatchObject({ day: 1, cap: 0.2, blocked: false });
    expect(dailyGuardState(weekly(0.2), new Date(reset).getTime() - 7 * DAY)).toMatchObject({ cap: 0.2, blocked: true });
  });

  it("raises the allowance by one fifth per weekday", () => {
    const state = dailyGuardState(weekly(0.29), new Date(reset).getTime() - 6 * DAY + 1);
    expect(state).toMatchObject({ day: 2, cap: 0.4, blocked: false });
  });

  it("keeps Friday's cap through the weekend, then opens Monday's allowance", () => {
    for (const date of ["2026-09-18", "2026-09-19", "2026-09-20"]) {
      expect(dailyGuardState(weekly(0.8), Date.parse(`${date}T12:00:00Z`))).toMatchObject({ day: 4, cap: 0.8, blocked: true });
    }
    expect(dailyGuardState(weekly(0.8), Date.parse("2026-09-21T00:00:00Z"))).toMatchObject({ day: 5, cap: 1, blocked: false });
  });

  it("does not open allowance before the first weekday of a weekend-start window", () => {
    const bucket = { ...weekly(0), resetsAt: "2026-09-26T09:30:00Z" };
    expect(dailyGuardState(bucket, Date.parse("2026-09-19T09:30:00Z"))).toMatchObject({ day: 0, cap: 0, blocked: true });
    expect(dailyGuardState(bucket, Date.parse("2026-09-21T09:29:59Z"))).toMatchObject({ day: 0 });
    expect(dailyGuardState(bucket, Date.parse("2026-09-21T09:30:00Z"))).toMatchObject({ day: 1, cap: 0.2 });
  });

  it("unlocks exactly five envelopes for any starting weekday", () => {
    for (let offset = 0; offset < 7; offset++) {
      const end = Date.parse(reset) + offset * DAY;
      expect(dailyGuardState({ ...weekly(0.99), resetsAt: new Date(end).toISOString() }, end - 1)).toMatchObject({ day: 5, cap: 1, blocked: false });
    }
  });

  it("does not invent a cap when the weekly reset is unavailable", () => {
    expect(dailyGuardState({ ...weekly(0.9), resetsAt: "" })).toBeNull();
    expect(dailyGuardState(weekly(0.9), Date.parse(reset))).toBeNull();
    expect(dailyGuardState(weekly(0.9), Date.parse(reset) - 8 * DAY)).toBeNull();
    expect(dailyGuardState({ ...weekly(0.9), windowHours: 5 })).toBeNull();
  });
});
