/**
 * Snoozing a task: it keeps its status and leaves the daily lists until its day or until one of
 * its links changes; the sweep brings it back with a history row signed by PPM (which is the
 * manager's news), "Back today" holds for that day, and a snoozed handed-off task is not checked
 * for being stalled. Writes keep the rules: a day after today, no snooze on a closed task (closing
 * clears one), "until a link changes" needs a Jira or PR link to watch.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { getDb } from "../../../../src/services/db.service.ts";
import {
  closeTask, countSnoozed, createTask, getTask, listTasks, listTasksNeedingCheck, resurfaceDueTasks, taskChildren, updateTask,
} from "../../../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { listResurfacedOn } from "../../../../src/services/ppm-tasks/ppm-tasks-read.ts";
import { taskHistory, undoChange } from "../../../../src/services/ppm-tasks/ppm-tasks-history.ts";
import { todayYmd } from "../../../../src/services/ppm-tasks/ppm-tasks-today.ts";
import { ppmTasksEvents, type PpmTasksEvent } from "../../../../src/services/ppm-tasks/ppm-tasks-events.ts";
import { formatManagerNews } from "../../../../src/services/ppm-tasks/ppm-task-manager-news.ts";
import { pendingManagerNews } from "../../../../src/services/ppm-tasks/ppm-tasks-deliver.ts";
import { digestResurfacedTasks } from "../../../../src/services/assistant-digest/digest-resurfaced-tasks.ts";
import { addDaysYmd, hasSnooze, shortDay, snoozeText, snoozeWakeReason, type TaskCreateInput } from "../../../../src/shared/ppm-tasks.ts";
import { chatOf, freshProject, MANAGER, PROJECT_PATH, USER, type Fixture } from "./ppm-tasks-fixture.ts";

const DAY = 86_400_000;
let f: Fixture;
let now: number;
let today: string;

beforeEach(() => {
  f = freshProject();
  now = Date.now();
  today = todayYmd(now);
});

const task = (title = "Merge to staging", extra: Partial<TaskCreateInput> = {}) =>
  createTask({ projectKey: f.projectKey, title, urgency: "now", importance: "must", ...extra }, USER, now);

/** A Jira link's cached state, changed at `at`. */
function linkChanged(ref: string, at: number): void {
  getDb().query(
    `INSERT INTO task_link_state (kind, ref, project_key, state_json, checked_at, changed_at) VALUES ('jira', ?, ?, '{"status":"Done"}', ?, ?)
     ON CONFLICT (kind, ref, project_key) DO UPDATE SET changed_at = excluded.changed_at`,
  ).run(ref, f.projectKey, at, at);
}

describe("the rules a snooze keeps (shared)", () => {
  it("runs out on its day, or on a link change after it was set, whichever comes first", () => {
    const s = { snoozedUntil: "2026-11-20", snoozeUntilChange: false, snoozedAt: 1_000 };
    expect(snoozeWakeReason(s, "2026-11-19", null)).toBeNull();
    expect(snoozeWakeReason(s, "2026-11-20", null)).toBe("date");
    expect(snoozeWakeReason(s, "2026-12-01", null)).toBe("date");
    const link = { snoozedUntil: null, snoozeUntilChange: true, snoozedAt: 1_000 };
    expect(snoozeWakeReason(link, "2030-01-01", null)).toBeNull();
    expect(snoozeWakeReason(link, "2030-01-01", 999)).toBeNull();
    expect(snoozeWakeReason(link, "2030-01-01", 1_001)).toBe("link");
    expect(snoozeWakeReason({ snoozedUntil: null, snoozeUntilChange: false, snoozedAt: null }, "2026-11-19", 5)).toBeNull();
  });

  it("counts days across months and years, and says when", () => {
    expect(addDaysYmd("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysYmd("2026-11-17", 7)).toBe("2026-11-24");
    expect(shortDay("2026-11-20", "2026-11-17")).toBe("Fri 20 Nov");
    expect(shortDay("2027-01-04", "2026-11-17")).toBe("Mon 4 Jan 2027");
    expect(snoozeText({ snoozedUntil: "2026-11-20", snoozeUntilChange: true }, "2026-11-17")).toBe("until Fri 20 Nov or a link changes");
    expect(snoozeText({ snoozedUntil: null, snoozeUntilChange: false })).toBeNull();
  });
});

describe("snoozing", () => {
  it("keeps the status, leaves the daily list and is counted; history says who snoozed it until when", () => {
    const t = task();
    const tomorrow = addDaysYmd(today, 1);
    const s = updateTask(t.id, { snoozedUntil: tomorrow }, t.revision, USER, now);
    expect(s).toMatchObject({ statusId: t.statusId, snoozedUntil: tomorrow, snoozeUntilChange: false, snoozed: true, resurfacedToday: false, revision: 2 });
    expect(s.snoozedAt).toBe(now);
    expect(listTasks({ projectKeys: [f.projectKey] }).map((x) => x.id)).not.toContain(t.id);
    expect(listTasks({ projectKeys: [f.projectKey], snoozed: "include" }).map((x) => x.id)).toContain(t.id);
    expect(listTasks({ projectKeys: [f.projectKey], snoozed: "only" }).map((x) => x.id)).toEqual([t.id]);
    expect(countSnoozed([f.projectKey])).toBe(1);
    expect(taskHistory(t.id)[0]).toMatchObject({ kind: "snoozed", actor: { kind: "user" }, changes: [{ field: "snoozedUntil", before: null, after: tomorrow }] });
    // Children lists and the task itself still show it.
    expect(getTask(t.id)!.snoozed).toBe(true);
    const child = task("Child", { parentId: t.id });
    updateTask(child.id, { snoozedUntil: tomorrow }, child.revision, USER, now);
    expect(taskChildren(t.id).map((c) => c.id)).toEqual([child.id]);
  });

  it("refuses a day that is not after today, or too far away", () => {
    const t = task();
    expect(() => updateTask(t.id, { snoozedUntil: today }, t.revision, USER, now)).toThrow(/after today/);
    expect(() => updateTask(t.id, { snoozedUntil: addDaysYmd(today, -3) }, t.revision, USER, now)).toThrow(/after today/);
    expect(() => updateTask(t.id, { snoozedUntil: "2026-13-40" }, t.revision, USER, now)).toThrow(/YYYY-MM-DD/);
    expect(() => updateTask(t.id, { snoozedUntil: addDaysYmd(today, 800) }, t.revision, USER, now)).toThrow(/two years/);
    expect(() => updateTask(t.id, { snoozeUntilChange: "yes" as unknown as boolean }, t.revision, USER, now)).toThrow(/true or false/);
    expect(getTask(t.id)!.revision).toBe(1);
  });

  it("needs a Jira or PR link to snooze until a link changes, and stops that when the last one goes", () => {
    const bare = task("No links", { links: [{ kind: "url", ref: "https://example.com" }] });
    expect(() => updateTask(bare.id, { snoozeUntilChange: true }, bare.revision, USER, now)).toThrow(/Jira or PR link/);
    const linked = task("Linked", { links: [{ kind: "jira", ref: "NX-1" }] });
    const s = updateTask(linked.id, { snoozeUntilChange: true }, linked.revision, USER, now);
    expect(s).toMatchObject({ snoozeUntilChange: true, snoozed: true });
    const unlinked = updateTask(linked.id, { links: [] }, s.revision, USER, now);
    expect(unlinked).toMatchObject({ snoozeUntilChange: false, snoozed: false, snoozedAt: null });
  });

  it("is refused on a closed task, and closing a snoozed task clears its snooze in the same change", () => {
    const t = task();
    const s = updateTask(t.id, { snoozedUntil: addDaysYmd(today, 3) }, t.revision, USER, now);
    const closed = closeTask(t.id, { closedAs: "done" }, s.revision, USER, now);
    expect(closed).toMatchObject({ baseGroup: "closed", snoozedUntil: null, snoozed: false, revision: s.revision + 1 });
    const last = taskHistory(t.id)[0]!;
    expect(last.kind).toBe("closed");
    expect(last.changes.map((c) => c.field)).toEqual(expect.arrayContaining(["statusId", "snoozedUntil"]));
    expect(() => updateTask(t.id, { snoozedUntil: addDaysYmd(today, 2) }, closed.revision, USER, now)).toThrow(/closed task/);
    expect(() => createTask({ projectKey: f.projectKey, title: "Done already", statusId: f.status("Done").id, snoozedUntil: addDaysYmd(today, 2) }, USER, now))
      .toThrow(/closed task/);
  });

  it("an AI snooze can be undone like any AI change", () => {
    const t = task();
    const s = updateTask(t.id, { snoozedUntil: addDaysYmd(today, 2) }, t.revision, MANAGER, now);
    const id = taskHistory(t.id)[0]!.id;
    undoChange(id, USER, now);
    expect(getTask(t.id)).toMatchObject({ snoozedUntil: null, snoozed: false, revision: s.revision + 1 });
  });

  it("can be set when the task is created", () => {
    const t = task("Later", { snoozedUntil: addDaysYmd(today, 7) });
    expect(t).toMatchObject({ snoozed: true, snoozedAt: now });
    expect(taskHistory(t.id)[0]!.kind).toBe("created");
  });
});

describe("coming back", () => {
  it("on its day: the sweep clears the snooze, signs a history row as PPM, emits once, and it reads Back today", () => {
    const t = task();
    updateTask(t.id, { snoozedUntil: addDaysYmd(today, 2) }, t.revision, USER, now);
    expect(resurfaceDueTasks(now)).toBe(0);
    const events: PpmTasksEvent[] = [];
    const off = ppmTasksEvents.on((e) => events.push(e));
    const later = now + 2 * DAY;
    const laterDay = todayYmd(later);
    // Read before the sweep: the day has come, so it is back already.
    expect(listTasks({ projectKeys: [f.projectKey] }, laterDay).find((x) => x.id === t.id)).toMatchObject({ snoozed: false, resurfacedToday: true });
    expect(resurfaceDueTasks(later)).toBe(1);
    expect(resurfaceDueTasks(later)).toBe(0);
    off();
    expect(events).toMatchObject([{ type: "task", kind: "resurfaced", taskIds: [t.id], actor: { kind: "ppm", label: "PPM" } }]);
    const back = getTask(t.id, laterDay)!;
    expect(back).toMatchObject({ snoozedUntil: null, snoozeUntilChange: false, snoozedAt: null, resurfacedAt: later, snoozed: false, resurfacedToday: true });
    expect(getTask(t.id, addDaysYmd(laterDay, 1))!.resurfacedToday).toBe(false);
    expect(taskHistory(t.id)[0]).toMatchObject({ kind: "resurfaced", actor: { kind: "ppm" }, reason: "Snooze ended: its day came" });
    expect(listResurfacedOn(laterDay).map((x) => x.id)).toEqual([t.id]);
  });

  it("when a watched link changes after the snooze was set, and not for a change before it", () => {
    const t = task("Wait for QA", { links: [{ kind: "jira", ref: "NX-7" }] });
    linkChanged("NX-7", now - 60_000);
    const s = updateTask(t.id, { snoozeUntilChange: true }, t.revision, USER, now);
    expect(s.snoozed).toBe(true);
    expect(resurfaceDueTasks(now + 1_000)).toBe(0);
    linkChanged("NX-7", now + 5_000);
    expect(listTasks({ projectKeys: [f.projectKey] }).find((x) => x.id === t.id)).toMatchObject({ snoozed: false, resurfacedToday: true });
    expect(resurfaceDueTasks(now + 6_000, [f.projectKey])).toBe(1);
    expect(getTask(t.id)).toMatchObject({ snoozeUntilChange: false, resurfacedAt: now + 6_000 });
    expect(taskHistory(t.id)[0]!.reason).toBe("Snooze ended: Jira NX-7 changed");
  });

  it("is news for the manager", () => {
    const t = task();
    updateTask(t.id, { snoozedUntil: addDaysYmd(today, 1) }, t.revision, USER, now);
    resurfaceDueTasks(now + 2 * DAY);
    const lines = formatManagerNews(pendingManagerNews(f.projectKey), f.projectKey).join("\n");
    expect(lines).toContain("snoozed until");
    expect(lines).toContain("back from snooze");
    expect(lines).toContain("by PPM");
  });

  it("is listed for the morning digest, and a project switched off is left alone", () => {
    const t = task("Back for the digest");
    updateTask(t.id, { snoozedUntil: addDaysYmd(today, 1) }, t.revision, USER, now);
    const later = now + DAY + 60_000;
    expect(digestResurfacedTasks(todayYmd(later), later)).toEqual([{ project: "demo", ref: "demo/1", title: "Back for the digest" }]);
    const u = task("Off project");
    updateTask(u.id, { snoozedUntil: addDaysYmd(today, 1) }, u.revision, USER, now);
    getDb().query("UPDATE task_projects SET enabled = 0").run();
    expect(resurfaceDueTasks(later)).toBe(0);
    expect(hasSnooze(getTask(u.id)!)).toBe(true);
  });
});

describe("handed-off work while snoozed", () => {
  it("is not checked for being stalled while snoozed, and is again once back", () => {
    getDb().query("INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at) VALUES (?, ?, 'mgr-1', 'claude', 'user', 1)")
      .run(f.projectKey, PROJECT_PATH);
    chatOf("mgr-1");
    chatOf("child-1");
    const t = task("Delegated");
    const handed = updateTask(t.id, { workingSessionId: "child-1" }, t.revision, MANAGER, now);
    expect(listTasksNeedingCheck(f.projectKey)).toHaveLength(1);
    const s = updateTask(t.id, { snoozedUntil: addDaysYmd(today, 1) }, handed.revision, USER, now);
    expect(listTasksNeedingCheck(f.projectKey)).toHaveLength(0);
    updateTask(t.id, { snoozedUntil: null }, s.revision, USER, now);
    expect(listTasksNeedingCheck(f.projectKey)).toHaveLength(1);
  });
});
