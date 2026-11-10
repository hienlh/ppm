/**
 * When the morning digest fires: the next HH:MM on the user's own clock, across a clock change,
 * east of UTC, after the time already passed today, and the fire a PPM that was off still owes.
 */
import { describe, expect, it } from "bun:test";
import {
  addDays, digestZone, instantOf, lastDigestFire, localDate, nextDigestFire,
} from "../../../../src/services/assistant-digest/digest-next-fire.ts";

const utc = (iso: string) => Date.parse(iso);

describe("nextDigestFire", () => {
  const cases: Array<[string, string, string, string, string]> = [
    // [zone, now (UTC), time, expected fire (UTC), expected local date]
    ["Asia/Ho_Chi_Minh", "2026-11-10T00:00:00Z", "08:00", "2026-11-10T01:00:00Z", "2026-11-10"],
    ["Asia/Ho_Chi_Minh", "2026-11-10T01:00:00Z", "08:00", "2026-11-11T01:00:00Z", "2026-11-11"],
    ["Asia/Ho_Chi_Minh", "2026-11-10T03:30:00Z", "08:00", "2026-11-11T01:00:00Z", "2026-11-11"],
    // Saigon is a day ahead of UTC late in the UTC evening.
    ["Asia/Ho_Chi_Minh", "2026-11-10T20:00:00Z", "08:00", "2026-11-11T01:00:00Z", "2026-11-11"],
    // London in winter is UTC, in summer UTC+1.
    ["Europe/London", "2026-11-10T07:59:00Z", "08:00", "2026-11-10T08:00:00Z", "2026-11-10"],
    ["Europe/London", "2026-07-01T06:00:00Z", "08:00", "2026-07-01T07:00:00Z", "2026-07-01"],
    // The night the clocks go forward (29 March 2026) and back (25 October 2026).
    ["Europe/London", "2026-03-28T09:00:00Z", "08:00", "2026-03-29T07:00:00Z", "2026-03-29"],
    ["Europe/London", "2026-10-24T09:00:00Z", "08:00", "2026-10-25T08:00:00Z", "2026-10-25"],
    // A time the clock skips lands just after the jump, never on the hour before.
    ["Europe/London", "2026-03-28T23:00:00Z", "01:30", "2026-03-29T01:30:00Z", "2026-03-29"],
    // West of UTC: exactly at the time (21:00 on the 9th, local) the next one is the 10th's.
    ["America/New_York", "2026-11-10T02:00:00Z", "21:00", "2026-11-11T02:00:00Z", "2026-11-10"],
  ];

  for (const [zone, now, time, fire, date] of cases) {
    it(`${zone} at ${now}, ${time} → ${fire}`, () => {
      const next = nextDigestFire(utc(now), time, zone);
      expect(new Date(next.at).toISOString()).toBe(new Date(utc(fire)).toISOString());
      expect(next.date).toBe(date);
      expect(localDate(next.at, zone)).toBe(date);
    });
  }

  it("is always strictly after now", () => {
    const at = instantOf("2026-11-10", "08:00", "Asia/Ho_Chi_Minh");
    expect(nextDigestFire(at, "08:00", "Asia/Ho_Chi_Minh").at).toBe(at + 24 * 60 * 60_000);
  });
});

describe("lastDigestFire", () => {
  it("is today's once the time passed, else yesterday's", () => {
    const zone = "Asia/Ho_Chi_Minh";
    expect(lastDigestFire(utc("2026-11-10T02:00:00Z"), "08:00", zone)).toEqual({ date: "2026-11-10", at: utc("2026-11-10T01:00:00Z") });
    expect(lastDigestFire(utc("2026-11-10T00:30:00Z"), "08:00", zone)).toEqual({ date: "2026-11-09", at: utc("2026-11-09T01:00:00Z") });
  });
});

describe("helpers", () => {
  it("moves dates across months and years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("falls back to the server's zone for none or an unknown one", () => {
    const server = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(digestZone(undefined)).toBe(server);
    expect(digestZone("Mars/Olympus")).toBe(server);
    expect(digestZone("Europe/London")).toBe("Europe/London");
  });
});
