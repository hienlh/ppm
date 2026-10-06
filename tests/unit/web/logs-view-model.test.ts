/**
 * The Logs window's pure rules: the query string the server reads back, where ranges start,
 * how repeats fold and where restart dividers go, and how a message is cut for drawing.
 */
import { describe, expect, it } from "bun:test";
import { parseLogQuery } from "../../../src/server/routes/logs.ts";
import {
  clockTime, foldRepeats, hitPattern, keySpan, logsQueryString, messagePieces, rangeCovering, rangeStart,
  restartDividers, shortCount, splitHits, timeSpan, utcOffsetLabel,
} from "../../../src/web/lib/logs/logs-view-model.ts";
import type { LogEntry } from "../../../src/shared/logs-model.ts";

const entry = (id: string, ts: number, msg: string, extra: Partial<LogEntry> = {}): LogEntry =>
  ({ id, ts, lv: "warn", src: "ai", tag: "chat", msg, ...extra });

describe("logsQueryString", () => {
  it("is read back by the server as the same query", () => {
    const params = {
      src: "ai" as const,
      levels: { error: true, warn: false, info: true, debug: false },
      tagsOff: ["ai:sdk"],
      q: "a&b c",
      regex: true,
      caseSensitive: false,
      chat: "53952680-0b07-4a2c-9d1e-0123456789ab",
      range: "today" as const,
      from: 1234,
      before: "p1.2f",
      limit: 500,
    };
    const back = parseLogQuery(Object.fromEntries(new URLSearchParams(logsQueryString(params))));
    expect(back).toEqual(params);
  });

  it("sends an empty level list as no levels rather than the defaults", () => {
    const q = logsQueryString({ src: "all", levels: { error: false, warn: false, info: false, debug: false }, tagsOff: [], q: "", regex: false, caseSensitive: false, chat: null, range: "1h", from: 0, limit: 10 });
    const back = parseLogQuery(Object.fromEntries(new URLSearchParams(q)));
    expect(back.levels).toEqual({ error: false, warn: false, info: false, debug: false });
  });
});

describe("ranges", () => {
  const now = Date.UTC(2026, 9, 6, 8, 30);

  it("counts back from now, and leaves the restart and everything to the server", () => {
    expect(rangeStart("15m", now)).toBe(now - 15 * 60_000);
    expect(rangeStart("1h", now)).toBe(now - 3_600_000);
    expect(rangeStart("restart", now)).toBe(0);
    expect(rangeStart("all", now)).toBe(0);
  });

  it("picks the narrowest range that still holds a line", () => {
    expect(rangeCovering(now - 10 * 60_000, now)).toBe("1h");
    expect(rangeCovering(now - 3 * 3_600_000, now)).toBe("today"); // bun test runs in UTC: midnight is 8.5 h back
    expect(rangeCovering(now - 30 * 3_600_000, now)).toBe("all");
  });
});

describe("times and counts", () => {
  it("writes a clock time to the millisecond", () => {
    expect(clockTime(Date.UTC(2026, 9, 6, 1, 35, 55, 748), true)).toBe("01:35:55.748");
  });

  it("names an offset the way the footer does", () => {
    expect(utcOffsetLabel(420)).toBe("UTC+7");
    expect(utcOffsetLabel(-210)).toBe("UTC-3:30");
    expect(utcOffsetLabel(0)).toBe("UTC");
  });

  it("collapses a span inside one second", () => {
    const t = Date.UTC(2026, 9, 6, 1, 35, 55, 100);
    expect(timeSpan(t, t + 500, true)).toBe("01:35:55");
    expect(timeSpan(t, t + 7000, true)).toBe("01:35:55 – 01:36:02");
  });

  it("shortens big counts", () => {
    expect(shortCount(9999)).toBe("9,999");
    expect(shortCount(73528)).toBe("73.5k");
    expect(shortCount(123456)).toBe("123k");
  });
});

describe("foldRepeats", () => {
  it("folds back-to-back copies under the first, and keeps a record with more lines apart", () => {
    const rows = foldRepeats([
      entry("a", 1, "dropping text"),
      entry("b", 2, "dropping text"),
      entry("c", 3, "dropping text"),
      entry("d", 4, "other"),
      entry("e", 5, "other", { more: ["  at x"] }),
      entry("f", 6, "other", { more: ["  at x"] }),
    ]);
    expect(rows.map((r) => [r.key, r.count, r.lastTs])).toEqual([["a", 3, 3], ["d", 1, 4], ["e", 1, 5], ["f", 1, 6]]);
    expect(rows[0]!.ids).toEqual(["a", "b", "c"]);
  });

  it("puts a restart divider above the first row after it, never at the top", () => {
    const rows = foldRepeats([entry("a", 10, "x"), entry("b", 20, "y"), entry("c", 30, "z")]);
    expect([...restartDividers(rows, [15, 5, 40])]).toEqual([["b", 15]]);
  });
});

describe("messagePieces", () => {
  it("turns a chat id into a chip and tones down keys and quoted values", () => {
    const sid = "53952680-0b07-4436-8959-7385b6e6cd06";
    expect(messagePieces(`session=${sid} turn ended: reason=usage_limit msg="a \\"b\\""`)).toEqual([
      { kind: "chat", sid },
      { kind: "text", text: " turn ended: " },
      { kind: "key", text: "reason=" },
      { kind: "text", text: "usage_limit " },
      { kind: "key", text: "msg=" },
      { kind: "quote", text: '"a \\"b\\""' },
    ]);
  });
});

describe("splitHits", () => {
  it("marks every hit, ignoring case when the search does", () => {
    expect(splitHits("Error then error", hitPattern(/error/i))).toEqual([
      { text: "Error", hit: true }, { text: " then ", hit: false }, { text: "error", hit: true },
    ]);
  });

  it("survives a pattern that matches the empty string", () => {
    expect(splitHits("abc", hitPattern(/x*/))).toEqual([{ text: "abc", hit: false }]);
  });
});

describe("keySpan", () => {
  it("selects from one key to another in either direction", () => {
    const keys = ["a", "b", "c", "d"];
    expect(keySpan(keys, "c", "a")).toEqual(["a", "b", "c"]);
    expect(keySpan(keys, "gone", "b")).toEqual(["b"]);
    expect(keySpan(keys, "x", "y")).toEqual([]);
  });
});
