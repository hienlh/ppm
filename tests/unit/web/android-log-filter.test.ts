/**
 * The log panel's filtering and ring maths.
 *
 * `appendBounded`'s de-duplication is the one worth the test: a reconnect replays the server's
 * whole ring, and without it the panel would show every entry twice after each blip — which
 * reads as the device logging twice, not as a client bug.
 */
import { describe, expect, it } from "bun:test";
import {
  appendBounded, EMPTY_FILTER, formatLogText, formatLogTime, matchesFilter, meetsLevel, LOG_LEVELS,
} from "../../../src/web/components/android/android-log-filter.ts";
import type { AndroidLogEntry, AndroidLogLevel } from "../../../src/shared/android-protocol.ts";

const entry = (over: Partial<AndroidLogEntry> = {}): AndroidLogEntry => ({
  id: 1, timestamp: 0, pid: 100, tid: 100, level: "info", tag: "Tag", message: "message", ...over,
});

describe("meetsLevel", () => {
  it("orders the six levels", () => {
    expect(LOG_LEVELS).toEqual(["verbose", "debug", "info", "warn", "error", "fatal"]);
  });

  it("is a minimum, not an equality", () => {
    expect(meetsLevel("error", "warn")).toBe(true);
    expect(meetsLevel("warn", "error")).toBe(false);
    expect(meetsLevel("warn", "warn")).toBe(true);
  });

  it("lets everything through at verbose", () => {
    for (const l of LOG_LEVELS) expect(meetsLevel(l as AndroidLogLevel, "verbose")).toBe(true);
  });
});

describe("matchesFilter", () => {
  it("passes everything with an empty filter", () => {
    expect(matchesFilter(entry(), EMPTY_FILTER)).toBe(true);
  });

  it("searches the tag and the message, case-insensitively", () => {
    expect(matchesFilter(entry({ tag: "ActivityManager" }), { ...EMPTY_FILTER, text: "activity" })).toBe(true);
    expect(matchesFilter(entry({ message: "Fatal signal 11" }), { ...EMPTY_FILTER, text: "SIGNAL" })).toBe(true);
    expect(matchesFilter(entry(), { ...EMPTY_FILTER, text: "nothing like it" })).toBe(false);
  });

  it("does not search the pid as text", () => {
    // A search for "100" must not match every entry from pid 100 — the pid has its own filter.
    expect(matchesFilter(entry({ pid: 100, tag: "T", message: "m" }), { ...EMPTY_FILTER, text: "100" })).toBe(false);
  });

  it("filters by pid when one is set", () => {
    expect(matchesFilter(entry({ pid: 42 }), { ...EMPTY_FILTER, pid: 42 })).toBe(true);
    expect(matchesFilter(entry({ pid: 43 }), { ...EMPTY_FILTER, pid: 42 })).toBe(false);
    expect(matchesFilter(entry({ pid: 43 }), { ...EMPTY_FILTER, pid: 0 })).toBe(true);
  });

  it("combines level and text", () => {
    const f = { ...EMPTY_FILTER, minimum: "error" as AndroidLogLevel, text: "boom" };
    expect(matchesFilter(entry({ level: "error", message: "boom" }), f)).toBe(true);
    expect(matchesFilter(entry({ level: "info", message: "boom" }), f)).toBe(false);
    expect(matchesFilter(entry({ level: "error", message: "quiet" }), f)).toBe(false);
  });

  it("ignores surrounding whitespace in the search", () => {
    expect(matchesFilter(entry({ message: "boom" }), { ...EMPTY_FILTER, text: "  boom  " })).toBe(true);
    expect(matchesFilter(entry(), { ...EMPTY_FILTER, text: "   " })).toBe(true);
  });
});

describe("appendBounded", () => {
  it("returns the same array when nothing arrives", () => {
    const existing = [entry({ id: 1 })];
    expect(appendBounded(existing, [], 10)).toBe(existing);
  });

  it("appends new entries", () => {
    const got = appendBounded([entry({ id: 1 })], [entry({ id: 2 }), entry({ id: 3 })], 10);
    expect(got.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("drops a replayed backlog rather than showing it twice", () => {
    const existing = [entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })];
    // A reconnect hands back the server's whole ring, which overlaps what we already hold.
    const got = appendBounded(existing, [entry({ id: 2 }), entry({ id: 3 }), entry({ id: 4 })], 10);
    expect(got.map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });

  it("returns the same array when the whole batch is a replay", () => {
    const existing = [entry({ id: 1 }), entry({ id: 2 })];
    expect(appendBounded(existing, [entry({ id: 1 }), entry({ id: 2 })], 10)).toBe(existing);
  });

  it("keeps the newest when it overflows", () => {
    const got = appendBounded([entry({ id: 1 }), entry({ id: 2 })], [entry({ id: 3 }), entry({ id: 4 })], 3);
    expect(got.map((e) => e.id)).toEqual([2, 3, 4]);
  });

  it("handles a first batch into an empty view", () => {
    expect(appendBounded([], [entry({ id: 5 })], 10).map((e) => e.id)).toEqual([5]);
  });
});

describe("formatting", () => {
  it("prints a local time with milliseconds", () => {
    // bun:test forces TZ=UTC (CLAUDE.md), so building the date locally keeps both sides aligned.
    const at = new Date(2026, 8, 21, 13, 9, 42, 640).getTime();
    expect(formatLogTime(at)).toBe("13:09:42.640");
  });

  it("writes one threadtime-shaped line per entry", () => {
    const at = new Date(2026, 8, 21, 1, 2, 3, 4).getTime();
    const text = formatLogText([entry({ timestamp: at, pid: 7, tid: 8, level: "warn", tag: "T", message: "m" })]);
    expect(text).toBe("01:02:03.004     7     8 W T: m");
  });

  it("joins with newlines and nothing else", () => {
    const text = formatLogText([entry({ id: 1 }), entry({ id: 2 })]);
    expect(text.split("\n")).toHaveLength(2);
  });
});
