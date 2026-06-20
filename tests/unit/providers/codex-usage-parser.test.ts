import { describe, it, expect } from "bun:test";
import { parseCodexUsage } from "../../../src/providers/codex-app-server/codex-usage-parser.ts";

describe("parseCodexUsage", () => {
  it("maps primary/secondary rate-limit windows to UsageInfo", () => {
    const resets = Math.floor(Date.now() / 1000) + 3600; // 1h from now, epoch seconds
    const u = parseCodexUsage({
      rateLimits: {
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: resets },
        secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: resets },
        planType: "plus",
      },
    });
    expect(u.fiveHour).toBeCloseTo(0.42, 5);
    expect(u.sevenDay).toBeCloseTo(0.10, 5);
    expect(u.fiveHourResetsAt).toBeTruthy();
    expect(u.session?.windowHours).toBe(5);
    expect(u.weekly?.windowHours).toBe(168);
    expect(u.activeAccountLabel).toBe("plus");
  });

  it("handles missing windows / empty input", () => {
    expect(parseCodexUsage(null)).toEqual({});
    expect(parseCodexUsage({ rateLimits: { primary: null, secondary: null } })).toEqual({});
  });

  it("tolerates millisecond resetsAt", () => {
    const ms = Date.now() + 3600_000;
    const u = parseCodexUsage({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: ms }, secondary: null } });
    expect(u.fiveHourResetsAt).toBe(new Date(ms).toISOString());
  });
});
