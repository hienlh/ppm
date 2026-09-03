import { describe, it, expect } from "bun:test";
import { formatDuration } from "../../../src/web/components/chat/team-member-activity-row.tsx";

describe("formatDuration", () => {
  it("formats hours and minutes for a long session", () => {
    expect(formatDuration("2026-09-03T00:19:00.000Z", "2026-09-03T01:23:00.000Z")).toBe("1h 4m");
  });

  it("formats minutes only under an hour", () => {
    expect(formatDuration("2026-09-03T00:00:00.000Z", "2026-09-03T00:12:30.000Z")).toBe("12m");
  });

  it("formats seconds for a just-started session", () => {
    expect(formatDuration("2026-09-03T00:00:00.000Z", "2026-09-03T00:00:45.000Z")).toBe("45s");
  });

  it("measures against now when no end is given", () => {
    const start = new Date(Date.now() - 5_000).toISOString();
    expect(formatDuration(start)).toMatch(/^\ds$/);
  });

  it("returns undefined without a start", () => {
    expect(formatDuration(undefined)).toBeUndefined();
    expect(formatDuration(undefined, "2026-09-03T01:00:00.000Z")).toBeUndefined();
  });

  it("returns undefined for unparseable timestamps", () => {
    expect(formatDuration("not-a-date", "2026-09-03T01:00:00.000Z")).toBeUndefined();
    expect(formatDuration("2026-09-03T01:00:00.000Z", "nonsense")).toBeUndefined();
  });

  it("returns undefined when the end precedes the start rather than showing negative time", () => {
    expect(formatDuration("2026-09-03T02:00:00.000Z", "2026-09-03T01:00:00.000Z")).toBeUndefined();
  });
});
