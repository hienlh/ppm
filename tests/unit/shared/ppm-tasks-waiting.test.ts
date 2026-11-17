/**
 * What a waiting task says about its wait, for every task view: on whom (the user stands out, a
 * member by name, an unknown id as it is, nobody named = only "Waiting"), until when (its due date,
 * else how long since its status moved into Waiting, else since someone was named), and when its
 * stay in the Waiting group began, read from its history.
 */
import { describe, expect, it } from "bun:test";
import {
  ageShort, dueText, isWaitingOnMe, isWaitingTask, waitedFor, waitedSince, waitingDetail, waitingStartedAtFromHistory,
  waitingUntilText, type WaitingFacts,
} from "../../../src/shared/ppm-tasks-waiting.ts";
import type { BaseGroup } from "../../../src/shared/ppm-tasks.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 17, 9, 0);
const names: Record<string, string> = { m1: "Việt", m2: "Azam" };
const nameOf = (id: string) => names[id] ?? null;
const facts = (over: Partial<WaitingFacts> = {}): WaitingFacts =>
  ({ baseGroup: "waiting", waitingOnMemberId: null, waitingSince: null, waitingStartedAt: null, dueDate: null, ...over });

describe("on whom", () => {
  it("names the user as you and marks the wait as theirs", () => {
    const w = waitingDetail(facts({ waitingOnMemberId: "me" }), nameOf)!;
    expect(w).toMatchObject({ label: "Waiting on you", name: "you", mine: true });
  });

  it("names a member by the project's member list", () => {
    expect(waitingDetail(facts({ waitingOnMemberId: "m1" }), nameOf)).toMatchObject({ label: "Waiting on Việt", mine: false });
  });

  it("shows an id that names no member as it is rather than dropping it", () => {
    expect(waitingDetail(facts({ waitingOnMemberId: "gone-42" }), nameOf)!.label).toBe("Waiting on gone-42");
  });

  it("says only Waiting when nobody is named", () => {
    expect(waitingDetail(facts(), nameOf)).toMatchObject({ label: "Waiting", name: null, mine: false });
  });

  it("covers a task outside the Waiting group that names someone, and no closed task", () => {
    expect(waitingDetail(facts({ baseGroup: "active", waitingOnMemberId: "m2" }), nameOf)!.label).toBe("Waiting on Azam");
    expect(waitingDetail(facts({ baseGroup: "active" }), nameOf)).toBeNull();
    expect(waitingDetail(facts({ baseGroup: "closed", waitingOnMemberId: "me" }), nameOf)).toBeNull();
    expect(isWaitingTask({ baseGroup: "not_started", waitingOnMemberId: null })).toBe(false);
  });

  it("isWaitingOnMe holds only for an open task waiting on the user", () => {
    expect(isWaitingOnMe({ baseGroup: "waiting", waitingOnMemberId: "me" })).toBe(true);
    expect(isWaitingOnMe({ baseGroup: "active", waitingOnMemberId: "me" })).toBe(true);
    expect(isWaitingOnMe({ baseGroup: "waiting", waitingOnMemberId: "m1" })).toBe(false);
    expect(isWaitingOnMe({ baseGroup: "waiting", waitingOnMemberId: null })).toBe(false);
    expect(isWaitingOnMe({ baseGroup: "closed", waitingOnMemberId: "me" })).toBe(false);
  });
});

describe("until when", () => {
  it("is the due date when there is one, however long it has waited", () => {
    const w = waitingDetail(facts({ waitingOnMemberId: "m1", dueDate: "2026-11-18", waitingStartedAt: NOW - 3 * DAY }), nameOf)!;
    expect(w.until).toEqual({ kind: "due", dueDate: "2026-11-18" });
    expect(waitingUntilText(w.until, "2026-11-17", NOW)).toBe("Due tomorrow");
  });

  it("is how long since the status moved into Waiting when there is no date", () => {
    const w = waitingDetail(facts({ waitingStartedAt: NOW - 2 * DAY, waitingSince: NOW - DAY, waitingOnMemberId: "m1" }), nameOf)!;
    expect(w.until).toEqual({ kind: "for", since: NOW - 2 * DAY });
    expect(ageShort(w.until!.kind === "for" ? w.until!.since : 0, NOW)).toBe("2d");
    expect(waitingUntilText(w.until, "2026-11-17", NOW)).toBe("for 2 days");
  });

  it("falls back to when someone was named when history has no move into Waiting", () => {
    expect(waitingDetail(facts({ waitingSince: NOW - 5 * 3_600_000, waitingOnMemberId: "me" }), nameOf)!.until).toEqual({ kind: "for", since: NOW - 5 * 3_600_000 });
    // Outside the Waiting group, the naming is the start, not a stale status move.
    expect(waitedSince({ baseGroup: "active", waitingSince: NOW - DAY, waitingStartedAt: NOW - 9 * DAY })).toBe(NOW - DAY);
  });

  it("is unknown when there is neither a date nor a start", () => {
    const w = waitingDetail(facts(), nameOf)!;
    expect(w.until).toBeNull();
    expect(waitingUntilText(w.until, "2026-11-17", NOW)).toBeNull();
  });

  it("words due dates and waits for text channels", () => {
    expect(dueText("2026-11-14", "2026-11-17")).toBe("Overdue (2026-11-14)");
    expect(dueText("2026-11-17", "2026-11-17")).toBe("Due today");
    expect(waitedFor(NOW - DAY, NOW)).toBe("1 day");
    expect(waitedFor(NOW - 20 * 60_000, NOW)).toBe("1 hour");
    expect(waitedFor(NOW - 3 * 3_600_000, NOW)).toBe("3 hours");
  });
});

describe("waitingStartedAtFromHistory", () => {
  const groups: Record<string, BaseGroup> = { todo: "not_started", doing: "active", wait: "waiting", review: "waiting", done: "closed" };
  const groupOf = (id: string) => groups[id];
  const move = (at: number, before: string | null, after: string) => ({ at, changes: [{ field: "statusId", before, after }] });

  it("is the move into the Waiting group", () => {
    expect(waitingStartedAtFromHistory([move(1, null, "todo"), move(5, "todo", "doing"), move(9, "doing", "wait")], groupOf)).toBe(9);
  });

  it("keeps the first move in when the task went between Waiting statuses", () => {
    expect(waitingStartedAtFromHistory([move(9, "doing", "wait"), move(12, "wait", "review")], groupOf)).toBe(9);
  });

  it("counts only the latest stay, not an earlier one", () => {
    expect(waitingStartedAtFromHistory([move(3, "todo", "wait"), move(5, "wait", "doing"), move(20, "doing", "wait")], groupOf)).toBe(20);
  });

  it("counts from creation for a task created in a Waiting status, and ignores other changes", () => {
    const entries = [{ at: 2, changes: [{ field: "title", before: null, after: "x" }, { field: "statusId", before: null, after: "wait" }] }, { at: 7, changes: [{ field: "notes", before: null, after: "n" }] }];
    expect(waitingStartedAtFromHistory(entries, groupOf)).toBe(2);
  });

  it("follows a deleted status whose group is on record, and stops at the hand-over when it is not", () => {
    // "gone" was a Waiting status, deleted at 30; its tasks moved to "wait".
    const entries = [move(4, "doing", "gone"), move(30, "gone", "wait")];
    expect(waitingStartedAtFromHistory(entries, (id) => (id === "gone" ? "waiting" : groupOf(id)))).toBe(4);
    // Its group no longer on record: the move out of it is not read as leaving another group.
    expect(waitingStartedAtFromHistory(entries, groupOf)).toBe(30);
    expect(waitingStartedAtFromHistory([move(30, "gone", "wait")], groupOf)).toBe(30);
  });

  it("orders two moves of the same millisecond by their row id", () => {
    const created = { id: 1, at: 50, changes: [{ field: "statusId", before: null, after: "todo" }] };
    const moved = { id: 2, at: 50, changes: [{ field: "statusId", before: "todo", after: "wait" }] };
    expect(waitingStartedAtFromHistory([created, moved], groupOf)).toBe(50);
    expect(waitingStartedAtFromHistory([moved, created], groupOf)).toBe(50);
  });

  it("is null when the latest move is out of Waiting or there is no move at all", () => {
    expect(waitingStartedAtFromHistory([move(3, "todo", "wait"), move(5, "wait", "doing")], groupOf)).toBeNull();
    expect(waitingStartedAtFromHistory([], groupOf)).toBeNull();
  });
});
