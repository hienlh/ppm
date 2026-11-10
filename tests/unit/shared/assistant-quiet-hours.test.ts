/**
 * Quiet hours: a daily window in the user's own zone, start inside and end outside, running past
 * midnight when it ends before it starts, empty when both are the same minute, off unless enabled.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_QUIET_HOURS, inQuietHours, isTimeZone, minutesOfDay, readQuietHours, readTimeZone,
} from "../../../src/shared/assistant-quiet-hours.ts";

const at = (iso: string) => Date.parse(iso);
const night = { enabled: true, start: "22:00", end: "07:00" };

describe("inQuietHours", () => {
  it("runs past midnight in the given zone", () => {
    // 15:30 UTC is 22:30 in Asia/Saigon (UTC+7) and 15:30 in London (UTC+0 in November).
    expect(inQuietHours(at("2026-11-10T15:30:00Z"), night, "Asia/Saigon")).toBe(true);
    expect(inQuietHours(at("2026-11-10T15:30:00Z"), night, "Europe/London")).toBe(false);
    expect(inQuietHours(at("2026-11-10T06:59:00Z"), night, "Europe/London")).toBe(true);
    expect(inQuietHours(at("2026-11-10T07:00:00Z"), night, "Europe/London")).toBe(false);
    expect(inQuietHours(at("2026-11-10T22:00:00Z"), night, "Europe/London")).toBe(true);
  });

  it("covers a window inside one day", () => {
    const lunch = { enabled: true, start: "12:00", end: "13:30" };
    expect(inQuietHours(at("2026-11-10T12:45:00Z"), lunch, "UTC")).toBe(true);
    expect(inQuietHours(at("2026-11-10T13:30:00Z"), lunch, "UTC")).toBe(false);
    expect(inQuietHours(at("2026-11-10T11:59:00Z"), lunch, "UTC")).toBe(false);
  });

  it("is never quiet when off or empty", () => {
    expect(inQuietHours(at("2026-11-10T23:00:00Z"), { ...night, enabled: false }, "UTC")).toBe(false);
    expect(inQuietHours(at("2026-11-10T23:00:00Z"), { enabled: true, start: "22:00", end: "22:00" }, "UTC")).toBe(false);
  });

  it("falls back to the server's zone for an unknown one", () => {
    expect(minutesOfDay(at("2026-11-10T01:02:00Z"), "Not/AZone")).toBe(minutesOfDay(at("2026-11-10T01:02:00Z")));
  });
});

describe("reading the settings", () => {
  it("keeps the defaults for what is missing and lists what is wrong", () => {
    const errors: string[] = [];
    expect(readQuietHours(undefined, errors)).toEqual(DEFAULT_QUIET_HOURS);
    expect(readQuietHours({ enabled: true, start: "23:15" }, errors)).toEqual({ enabled: true, start: "23:15", end: "07:00" });
    expect(errors).toEqual([]);
    readQuietHours({ enabled: "yes", start: "25:00", end: "7" }, errors);
    expect(errors).toHaveLength(3);
  });

  it("takes an IANA zone the runtime knows, nothing else", () => {
    const errors: string[] = [];
    expect(readTimeZone("Europe/London", errors)).toBe("Europe/London");
    expect(readTimeZone("", errors)).toBeUndefined();
    expect(readTimeZone("Mars/Base", errors)).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(isTimeZone("x".repeat(100))).toBe(false);
  });
});
