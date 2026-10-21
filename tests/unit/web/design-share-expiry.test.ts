import { describe, expect, it } from "bun:test";
import {
  choiceForExpiry, endOfLocalDay, expiresInLabel, expiryFromChoice, maxCustomDate, minCustomDate, toDateInputValue,
} from "../../../src/web/lib/design/design-share-expiry";
import { SHARE_LIMITS } from "../../../src/shared/design-share-types";

const DAY = 24 * 60 * 60 * 1000;
// A fixed local noon, so day arithmetic never straddles a DST change at midnight.
const now = new Date(2026, 9, 21, 12, 0, 0).getTime();

describe("share link expiry", () => {
  it("turns each preset into a time from now, and Never into null", () => {
    expect(expiryFromChoice({ preset: "1d", customDate: "" }, now)).toEqual({ ok: true, expiresAt: now + DAY });
    expect(expiryFromChoice({ preset: "7d", customDate: "" }, now)).toEqual({ ok: true, expiresAt: now + 7 * DAY });
    expect(expiryFromChoice({ preset: "30d", customDate: "" }, now)).toEqual({ ok: true, expiresAt: now + 30 * DAY });
    expect(expiryFromChoice({ preset: "never", customDate: "2026-10-30" }, now)).toEqual({ ok: true, expiresAt: null });
  });

  it("gives a custom day until its last millisecond in local time", () => {
    const r = expiryFromChoice({ preset: "custom", customDate: "2026-11-02" }, now);
    expect(r).toEqual({ ok: true, expiresAt: new Date(2026, 10, 2, 23, 59, 59, 999).getTime() });
    // Today is still allowed: its end is ahead.
    expect(expiryFromChoice({ preset: "custom", customDate: "2026-10-21" }, now).ok).toBe(true);
  });

  it("refuses a custom day that is missing, malformed, past, or more than a year ahead", () => {
    expect(expiryFromChoice({ preset: "custom", customDate: "" }, now)).toEqual({ ok: false, error: "Pick a date" });
    expect(expiryFromChoice({ preset: "custom", customDate: "2026-02-31" }, now).ok).toBe(false);
    expect(expiryFromChoice({ preset: "custom", customDate: "2026-10-20" }, now))
      .toEqual({ ok: false, error: "Pick a date that is still ahead" });
    const tooFar = toDateInputValue(now + SHARE_LIMITS.maxExpiryMs + DAY);
    expect(expiryFromChoice({ preset: "custom", customDate: tooFar }, now))
      .toEqual({ ok: false, error: "A link can stay open for at most a year" });
  });

  it("offers custom days from today to the last one whose end is inside the cap", () => {
    expect(minCustomDate(now)).toBe("2026-10-21");
    const max = maxCustomDate(now);
    const end = endOfLocalDay(max)!;
    expect(end).toBeLessThanOrEqual(now + SHARE_LIMITS.maxExpiryMs);
    expect(expiryFromChoice({ preset: "custom", customDate: max }, now).ok).toBe(true);
    // The day after the max is refused, so the input's max is not one day short.
    const next = toDateInputValue(end + 1);
    expect(expiryFromChoice({ preset: "custom", customDate: next }, now).ok).toBe(false);
  });

  it("starts Change expiry at Never or at the link's own day", () => {
    expect(choiceForExpiry(null, now).preset).toBe("never");
    expect(choiceForExpiry(now + 3 * DAY, now)).toEqual({ preset: "custom", customDate: "2026-10-24" });
  });

  it("words the time left", () => {
    expect(expiresInLabel(null, now)).toBeNull();
    expect(expiresInLabel(now - 1, now)).toBe("Expired");
    expect(expiresInLabel(now + 30 * 60 * 1000, now)).toBe("Expires in under an hour");
    expect(expiresInLabel(now + 60 * 60 * 1000, now)).toBe("Expires in 1 hour");
    expect(expiresInLabel(now + 5 * 60 * 60 * 1000, now)).toBe("Expires in 5 hours");
    expect(expiresInLabel(now + DAY, now)).toBe("Expires in 1 day");
    expect(expiresInLabel(now + 7 * DAY, now)).toBe("Expires in 7 days");
    // Read a moment after it was set, a 7-day expiry still says 7 days.
    expect(expiresInLabel(now + 7 * DAY - 5000, now)).toBe("Expires in 7 days");
    expect(expiresInLabel(now + 23.6 * 60 * 60 * 1000, now)).toBe("Expires in 1 day");
  });
});
