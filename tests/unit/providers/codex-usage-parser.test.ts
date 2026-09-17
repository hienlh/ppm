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
    expect(u.activeAccountLabel).toBe("ChatGPT Plus");
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

describe("parseCodexUsage — windows are read by duration, not by slot", () => {
  it("puts a Business plan's lone weekly window in the weekly bucket", () => {
    // Exactly what a ChatGPT Business account returns: one 10080-minute window, in the
    // PRIMARY slot, with no secondary at all. Read positionally it became a "5-Hour"
    // quota resetting nearly seven days out, and the real Weekly row stayed blank.
    const resets = Math.floor(Date.now() / 1000) + 7 * 86400;
    const u = parseCodexUsage({
      rateLimits: {
        primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: resets },
        secondary: null,
        planType: "self_serve_business_prolite",
      },
    });
    expect(u.sevenDay).toBe(0);
    expect(u.weekly?.windowHours).toBe(168);
    // No short window exists on this plan, so claiming one would be inventing a limit.
    expect(u.fiveHour).toBeUndefined();
    expect(u.session).toBeUndefined();
  });

  it("still reads a Plus plan's two windows correctly", () => {
    const now = Math.floor(Date.now() / 1000);
    const u = parseCodexUsage({
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now + 900 },
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: now + 4 * 86400 },
        planType: "plus",
      },
    });
    expect(u.fiveHour).toBe(1);
    expect(u.session?.windowHours).toBe(5);
    expect(u.sevenDay).toBeCloseTo(0.4, 5);
    expect(u.weekly?.windowHours).toBe(168);
  });

  it("treats a day-long window as the long bucket", () => {
    const u = parseCodexUsage({
      rateLimits: { primary: { usedPercent: 25, windowDurationMins: 1440, resetsAt: null }, secondary: null },
    });
    expect(u.sevenDay).toBeCloseTo(0.25, 5);
    expect(u.fiveHour).toBeUndefined();
  });

  it("falls back to slot order when a window declares no duration", () => {
    // Nothing to read means nothing to judge by, so position is the only signal left.
    const u = parseCodexUsage({
      rateLimits: {
        primary: { usedPercent: 30, windowDurationMins: null, resetsAt: null },
        secondary: { usedPercent: 60, windowDurationMins: null, resetsAt: null },
      },
    });
    expect(u.fiveHour).toBeCloseTo(0.3, 5);
    expect(u.sevenDay).toBeCloseTo(0.6, 5);
  });
});
