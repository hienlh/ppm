/**
 * The red dot and the count on the rail's Schedules button. A problem is one occurrence with its
 * own key: dismissing it hides that one, a newer failure shows again, and a run that succeeds
 * clears it by itself. The count is schedules (not fires) going out within 24 hours.
 */
import { describe, expect, it } from "bun:test";
import {
  firesWithin, parseStamp, railSummary, scheduleAttention, scheduleProblem, WAITING_TOO_LONG_MS, type AttentionInput, type UpcomingInput,
} from "../../../src/shared/schedule-attention.ts";

const NOW = Date.parse("2026-11-17T10:20:00Z");
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

const base = (over: Partial<AttentionInput & UpcomingInput> = {}): AttentionInput & UpcomingInput => ({
  kind: "prompt", mode: "tick", enabled: 1, timeout_ms: 30 * 60_000, paused_reason: null, pending_since: null,
  attention_dismissed: null, last_run: null, next_fire_at: iso(60 * 60_000), ...over,
});
const run = (id: number, status: "running" | "done" | "error", startedAgoMs = 60_000, error: string | null = null) =>
  ({ id, status, started_at: iso(-startedAgoMs), ended_at: status === "running" ? null : iso(-1000), error, session_id: null });

describe("scheduleProblem", () => {
  it("is nothing for a schedule that ran fine or never ran", () => {
    expect(scheduleProblem(base(), NOW)).toBeNull();
    expect(scheduleProblem(base({ last_run: run(4, "done") }), NOW)).toBeNull();
  });

  it("names a failed last run by that run", () => {
    expect(scheduleProblem(base({ last_run: run(7, "error", 60_000, "timed out") }), NOW)).toEqual({
      kind: "failed", key: "failed:7", text: "Last run failed", detail: "timed out",
    });
  });

  it("calls a run past its time limit stuck, but not one still inside it, nor an always-on script", () => {
    expect(scheduleProblem(base({ last_run: run(8, "running", 29 * 60_000) }), NOW)).toBeNull();
    const stuck = scheduleProblem(base({ last_run: run(8, "running", 41 * 60_000) }), NOW);
    expect(stuck).toMatchObject({ kind: "stuck", key: "stuck:8", text: "Stuck: running 41 min" });
    expect(scheduleProblem(base({ mode: "always-on", last_run: run(8, "running", 5 * 86_400_000) }), NOW)).toBeNull();
  });

  it("flags a paused reminder and one waiting for its chat too long, before any run", () => {
    const paused = base({ kind: "session", paused_reason: "The chat was deleted", last_run: run(1, "error"), updated_at: "2026-11-17 09:00:00" });
    expect(scheduleProblem(paused, NOW)).toMatchObject({ kind: "paused", key: "paused:The chat was deleted@2026-11-17 09:00:00" });
    // The same reason set again later is a new pause: a dismissed one does not hide it.
    expect(scheduleAttention({ ...paused, updated_at: "2026-11-18 09:00:00", attention_dismissed: "paused:The chat was deleted@2026-11-17 09:00:00" }, NOW)?.kind).toBe("paused");
    expect(scheduleProblem(base({ kind: "session", pending_since: iso(-(WAITING_TOO_LONG_MS - 1000)) }), NOW)).toBeNull();
    const since = iso(-14 * 60_000);
    expect(scheduleProblem(base({ kind: "session", pending_since: since }), NOW)).toMatchObject({ kind: "waiting", key: `waiting:${since}`, text: "Waiting for its chat 14 min" });
  });

  it("is nothing for a schedule the user turned off", () => {
    expect(scheduleProblem(base({ enabled: 0, last_run: run(3, "error") }), NOW)).toBeNull();
  });
});

describe("parseStamp", () => {
  it("reads SQLite's zone-less stamp as UTC, as the run rows mean it", () => {
    expect(parseStamp("2026-11-17 10:00:00")).toBe(Date.parse("2026-11-17T10:00:00Z"));
    expect(parseStamp("2026-11-17T10:00:00.000Z")).toBe(Date.parse("2026-11-17T10:00:00Z"));
  });

  it("measures a stuck run from a SQLite stamp in UTC whatever the device's zone", () => {
    const startedUtc = new Date(NOW - 41 * 60_000).toISOString().slice(0, 19).replace("T", " ");
    const r = { id: 8, status: "running" as const, started_at: startedUtc, ended_at: null, error: null, session_id: null };
    expect(scheduleProblem(base({ last_run: r }), NOW)?.kind).toBe("stuck");
  });
});

describe("scheduleAttention", () => {
  it("hides the dismissed problem and shows the next one", () => {
    expect(scheduleAttention(base({ last_run: run(7, "error"), attention_dismissed: "failed:7" }), NOW)).toBeNull();
    expect(scheduleAttention(base({ last_run: run(9, "error"), attention_dismissed: "failed:7" }), NOW)?.key).toBe("failed:9");
  });
});

describe("firesWithin and railSummary", () => {
  it("counts a schedule whose next fire is within 24 hours, or one already due, once each", () => {
    expect(firesWithin(base({ next_fire_at: iso(23 * 3_600_000) }), NOW)).toBe(true);
    expect(firesWithin(base({ next_fire_at: iso(25 * 3_600_000) }), NOW)).toBe(false);
    expect(firesWithin(base({ kind: "session", next_fire_at: null, pending_since: iso(-1000) }), NOW)).toBe(true);
    expect(firesWithin(base({ enabled: 0 }), NOW)).toBe(false);
    expect(firesWithin(base({ paused_reason: "gone" }), NOW)).toBe(false);
    expect(firesWithin(base({ mode: "always-on", next_fire_at: null }), NOW)).toBe(false);
  });

  it("adds them up for the button", () => {
    const list = [
      base(), base({ next_fire_at: iso(5 * 60_000), last_run: run(1, "error") }), base({ next_fire_at: iso(3 * 86_400_000) }),
      base({ last_run: run(2, "error"), attention_dismissed: "failed:2" }),
    ];
    expect(railSummary(list, NOW)).toEqual({ upcoming: 3, attention: 1 });
  });
});
