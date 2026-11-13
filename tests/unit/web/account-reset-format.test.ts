/**
 * Reset times in two levels of detail: the quick views (the ··· menu, the usage rings' tooltip)
 * say the countdown alone, "in 3h 12m"; Switch account's cards add the clock time, as short as
 * it can be without being ambiguous.
 */
import { describe, expect, it } from "bun:test";
import {
  bucketResetsAt, formatResetClock, formatResetCountdown, formatResetLine,
} from "../../../src/web/components/settings/accounts/account-usage-format";

// A fixed local moment: Tuesday 10 Nov 2026, 00:40.
const NOW = new Date(2026, 10, 10, 0, 40).getTime();
const at = (mins: number) => new Date(NOW + mins * 60_000).toISOString();

describe("formatResetCountdown", () => {
  it("keeps two units at most", () => {
    expect(formatResetCountdown(at(192), NOW)).toBe("in 3h 12m");
    expect(formatResetCountdown(at(2 * 1440 + 8 * 60 + 15), NOW)).toBe("in 2d 8h");
    expect(formatResetCountdown(at(40), NOW)).toBe("in 40m");
    expect(formatResetCountdown(at(120), NOW)).toBe("in 2h");
    expect(formatResetCountdown(at(1440), NOW)).toBe("in 1d");
  });

  it("says now once the moment has passed, and nothing without a moment", () => {
    expect(formatResetCountdown(at(-5), NOW)).toBe("now");
    expect(formatResetCountdown(null, NOW)).toBeNull();
    expect(formatResetCountdown("not a date", NOW)).toBeNull();
  });
});

describe("formatResetClock", () => {
  it("a bare time within 12 hours, even past midnight", () => {
    expect(formatResetClock(at(192), NOW)).toBe("03:52");
  });

  it("later today, then the weekday within the week, then the date", () => {
    expect(formatResetClock(at(17 * 60 + 20), NOW)).toBe("today 18:00");
    expect(formatResetClock(at(2 * 1440 + 8 * 60 + 20), NOW)).toBe("Thu 09:00");
    expect(formatResetClock(at(8 * 1440), NOW)).toBe("Nov 18 00:40");
  });
});

describe("formatResetLine", () => {
  it("joins the countdown and the clock", () => {
    expect(formatResetLine(at(192), NOW)).toBe("Resets in 3h 12m · 03:52");
    expect(formatResetLine(at(2 * 1440 + 8 * 60 + 20), NOW)).toBe("Resets in 2d 8h · Thu 09:00");
    expect(formatResetLine(at(17 * 60 + 20), NOW)).toBe("Resets in 17h 20m · today 18:00");
    expect(formatResetLine(at(-1), NOW)).toBe("Resets now");
    expect(formatResetLine(null, NOW)).toBeNull();
  });
});

describe("bucketResetsAt", () => {
  const base = { utilization: 0.4, windowHours: 5 };
  it("prefers the moment the server sent, else turns a countdown into one", () => {
    expect(bucketResetsAt({ ...base, resetsAt: at(30), resetsInMinutes: 99, resetsInHours: null }, NOW)).toBe(at(30));
    expect(bucketResetsAt({ ...base, resetsAt: "", resetsInMinutes: 90, resetsInHours: null }, NOW)).toBe(at(90));
    expect(bucketResetsAt({ ...base, resetsAt: "", resetsInMinutes: null, resetsInHours: 2 }, NOW)).toBe(at(120));
    expect(bucketResetsAt({ ...base, resetsAt: "", resetsInMinutes: null, resetsInHours: null }, NOW)).toBeNull();
    expect(bucketResetsAt(undefined, NOW)).toBeNull();
  });

  /**
   * The shape the Claude paths build when the provider sent no `resets_at` — an idle account's
   * five-hour window, a third of the stored readings. Zero there means "nothing was said", so
   * the bars say nothing rather than "Resets now".
   */
  it("reads a zero countdown as no reset time at all", () => {
    expect(bucketResetsAt({ ...base, resetsAt: "", resetsInMinutes: 0, resetsInHours: null }, NOW)).toBeNull();
    expect(bucketResetsAt({ ...base, resetsAt: "", resetsInMinutes: null, resetsInHours: 0, windowHours: 168 }, NOW)).toBeNull();
    expect(formatResetLine(bucketResetsAt({ ...base, resetsAt: "", resetsInMinutes: 0, resetsInHours: null }, NOW), NOW)).toBeNull();
  });
});
