import { describe, expect, it } from "bun:test";
import { dailyGuardState } from "../../../src/shared/codex-daily-guard.ts";

const DAY = 24 * 60 * 60 * 1000;
const reset = new Date("2026-09-22T00:00:00.000Z").toISOString();

function weekly(utilization: number) {
  return { utilization, resetsAt: reset, resetsInMinutes: null, resetsInHours: null, windowHours: 168 };
}

describe("Codex daily guard", () => {
  it("starts each weekly window with one seventh of the quota", () => {
    const state = dailyGuardState(weekly(0.14), new Date(reset).getTime() - 7 * DAY + 1);
    expect(state).toMatchObject({ day: 1, cap: 1 / 7, blocked: false });
  });

  it("raises the allowance by one seventh per completed day", () => {
    const state = dailyGuardState(weekly(0.29), new Date(reset).getTime() - 6 * DAY + 1);
    expect(state).toMatchObject({ day: 2, cap: 2 / 7, blocked: true });
  });

  it("does not invent a cap when the weekly reset is unavailable", () => {
    expect(dailyGuardState({ ...weekly(0.9), resetsAt: "" })).toBeNull();
  });
});
