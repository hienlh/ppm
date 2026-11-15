import { beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { getDb } from "../../../../src/services/db.service.ts";
import {
  closeTask, createTask, decideTask, getTask, listTasks, listTasksNeedingCheck, reopenTask, reorderTask,
  setTaskDecision, softDeleteTask, taskChildren, updateTask,
} from "../../../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { TaskConflictError, PpmTaskError } from "../../../../src/services/ppm-tasks/ppm-tasks-errors.ts";
import { taskHistory } from "../../../../src/services/ppm-tasks/ppm-tasks-history.ts";
import { setTasksEnabled } from "../../../../src/services/ppm-tasks/ppm-tasks-projects.service.ts";
import { ppmTasksEvents, type PpmTasksEvent } from "../../../../src/services/ppm-tasks/ppm-tasks-events.ts";
import { freshProject, MANAGER, PROJECT_PATH, USER, type Fixture } from "./ppm-tasks-fixture.ts";

let f: Fixture;
beforeEach(() => { f = freshProject(); });

const historyCount = () => (getDb().query("SELECT COUNT(*) AS n FROM task_history WHERE task_id IS NOT NULL").get() as { n: number }).n;

describe("create", () => {
  it("numbers tasks per project and applies defaults", () => {
    const a = createTask({ projectKey: f.projectKey, title: "First" }, USER);
    const b = createTask({ projectKey: f.projectKey, title: "Second", urgency: "now", importance: "must" }, USER);
    expect(a).toMatchObject({ number: 1, type: "task", urgency: "later", importance: "should", revision: 1, statusId: f.status("To do").id, baseGroup: "not_started" });
    expect(b).toMatchObject({ number: 2, urgency: "now", importance: "must" });
    expect(taskHistory(a.id)).toHaveLength(1);
    expect(taskHistory(a.id)[0]).toMatchObject({ kind: "created", actor: { kind: "user", label: "You" }, via: "ppm" });
  });

  it("stores links canonically, fields and a decision", () => {
    const t = createTask({
      projectKey: f.projectKey, title: "Pension",
      links: [{ kind: "jira", ref: "nx-6318" }, { kind: "pr", ref: "https://github.com/acme/umbrella-fe/pull/412" }, { kind: "jira", ref: "NX-6318" }],
      fields: { Sprint: 47, Customer: "Acme Payroll" },
      decision: { question: "Which way?", options: ["Monthly", "Weekly"] },
    }, USER);
    expect(t.links).toEqual([{ kind: "jira", ref: "NX-6318", label: null }, { kind: "pr", ref: "acme/umbrella-fe#412", label: null }]);
    expect(t.fields).toEqual({ Sprint: 47, Customer: "Acme Payroll" });
    expect(t.type).toBe("decision");
    expect(t.decision).toEqual({ question: "Which way?", options: [{ id: "a", label: "Monthly" }, { id: "b", label: "Weekly" }], chosen: null });
  });

  it("refuses bad input and a switched-off project", () => {
    expect(() => createTask({ projectKey: f.projectKey, title: "" }, USER)).toThrow(PpmTaskError);
    expect(() => createTask({ projectKey: f.projectKey, title: "x", type: "epic" }, USER)).toThrow(/type must be/);
    expect(() => createTask({ projectKey: f.projectKey, title: "x", fields: { "bad key": "1" } }, USER)).toThrow(/Field name/);
    expect(() => createTask({ projectKey: f.projectKey, title: "x", links: [{ kind: "pr", ref: "not a pr" }] }, USER)).toThrow(/valid pr/);
    setTasksEnabled(PROJECT_PATH, false, USER);
    expect(() => createTask({ projectKey: f.projectKey, title: "x" }, USER)).toThrow(/switched off/);
  });
});

describe("update", () => {
  it("refuses a stale revision and writes nothing", () => {
    const t = createTask({ projectKey: f.projectKey, title: "Race" }, USER);
    updateTask(t.id, { title: "Winner" }, 1, USER);
    const before = historyCount();
    let err: unknown;
    try { updateTask(t.id, { title: "Loser" }, 1, MANAGER); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TaskConflictError);
    expect((err as TaskConflictError).currentRevision).toBe(2);
    expect(getTask(t.id)).toMatchObject({ title: "Winner", revision: 2 });
    expect(historyCount()).toBe(before);
  });

  it("records only real changes, and a no-op bumps nothing", () => {
    const t = createTask({ projectKey: f.projectKey, title: "Same" }, USER);
    const same = updateTask(t.id, { title: "Same" }, 1, USER);
    expect(same.revision).toBe(1);
    const changed = updateTask(t.id, { why: "because", fields: { Sprint: 1 } }, 1, MANAGER);
    expect(changed.revision).toBe(2);
    expect(taskHistory(t.id)[0]!.changes).toEqual([
      { field: "why", before: null, after: "because" }, { field: "fields.Sprint", before: null, after: 1 },
    ]);
    const removed = updateTask(t.id, { fields: { Sprint: null, Other: "x" } }, 2, USER);
    expect(removed.fields).toEqual({ Other: "x" });
  });

  it("sets waiting since, closed time and status kinds", () => {
    const t = createTask({ projectKey: f.projectKey, title: "Flow" }, USER);
    const waiting = updateTask(t.id, { waitingOnMemberId: "me", statusId: f.status("Waiting").id }, 1, USER);
    expect(waiting.waitingSince).not.toBeNull();
    expect(taskHistory(t.id)[0]!.kind).toBe("status");
    const closed = closeTask(t.id, { closedAs: "dropped" }, 2, USER);
    expect(closed).toMatchObject({ statusId: f.status("Dropped").id, closedAs: "dropped", baseGroup: "closed" });
    expect(closed.closedAt).not.toBeNull();
    expect(taskHistory(t.id)[0]!.kind).toBe("closed");
    const reopened = reopenTask(t.id, {}, 3, USER);
    expect(reopened).toMatchObject({ closedAt: null, statusId: f.status("To do").id });
    expect(taskHistory(t.id)[0]!.kind).toBe("reopened");
  });

  it("refuses a parent cycle", () => {
    const a = createTask({ projectKey: f.projectKey, title: "A" }, USER);
    const b = createTask({ projectKey: f.projectKey, title: "B", parentId: a.id }, USER);
    expect(() => updateTask(a.id, { parentId: b.id }, 1, USER)).toThrow(/ancestor/);
    expect(taskChildren(a.id).map((c) => c.id)).toEqual([b.id]);
  });

  it("records a result, and decisions are chosen from their options", () => {
    const t = createTask({ projectKey: f.projectKey, title: "D" }, USER);
    const d = setTaskDecision(t.id, { options: ["Yes", "No"] }, 1, USER);
    expect(d.type).toBe("decision");
    expect(() => decideTask(t.id, "z", 2, USER)).toThrow(/No option/);
    const chosen = decideTask(t.id, "b", 2, USER);
    expect(chosen.decision?.chosen).toMatchObject({ optionId: "b", by: "You" });
    expect(taskHistory(t.id)[0]!.kind).toBe("decided");
    const r = updateTask(t.id, { result: { text: "Went with No" } }, 3, MANAGER);
    expect(r.result).toMatchObject({ text: "Went with No", by: "Manager demo" });
    expect(taskHistory(t.id)[0]!.kind).toBe("result");
  });

  it("soft-deletes and hides", () => {
    const t = createTask({ projectKey: f.projectKey, title: "Gone" }, USER);
    softDeleteTask(t.id, 1, USER);
    expect(listTasks({ projectKeys: [f.projectKey] })).toHaveLength(0);
    expect(getTask(t.id)?.deletedAt).not.toBeNull();
    expect(() => updateTask(t.id, { title: "x" }, 2, USER)).toThrow(/not found/);
  });

  it("emits one event per change, after the commit", () => {
    const seen: PpmTasksEvent[] = [];
    const off = ppmTasksEvents.on((e) => seen.push(e));
    try {
      const t = createTask({ projectKey: f.projectKey, title: "Ev" }, USER);
      updateTask(t.id, { title: "Ev2" }, 1, MANAGER);
      expect(seen.map((e) => (e.type === "task" ? e.kind : e.type))).toEqual(["created", "updated"]);
    } finally { off(); }
  });
});

describe("order", () => {
  it("sorts by effective urgency, importance, then manual rank", () => {
    const today = "2026-11-16";
    const later = createTask({ projectKey: f.projectKey, title: "later-must", urgency: "later", importance: "must" }, USER);
    const dueTomorrow = createTask({ projectKey: f.projectKey, title: "due-tomorrow", urgency: "later", importance: "nice", dueDate: "2026-11-17" }, USER);
    const nowShould = createTask({ projectKey: f.projectKey, title: "now-should", urgency: "now", importance: "should" }, USER);
    const nowMust1 = createTask({ projectKey: f.projectKey, title: "now-must-1", urgency: "now", importance: "must" }, USER);
    const nowMust2 = createTask({ projectKey: f.projectKey, title: "now-must-2", urgency: "now", importance: "must" }, USER);
    const titles = () => listTasks({ projectKeys: [f.projectKey] }, today).map((t) => t.title);
    expect(titles()).toEqual(["now-must-1", "now-must-2", "now-should", "due-tomorrow", "later-must"]);
    expect(listTasks({}, today).find((t) => t.id === dueTomorrow.id)).toMatchObject({ effectiveUrgency: "today", urgencyRaised: true });
    reorderTask(nowMust2.id, { beforeId: nowMust1.id }, 1, USER);
    expect(titles().slice(0, 2)).toEqual(["now-must-2", "now-must-1"]);
    expect(() => reorderTask(later.id, { beforeId: nowShould.id }, 1, USER)).toThrow(/same urgency/);
  });

  it("renumbers a crowded cell before a midpoint insert, bumping no other revision", () => {
    const tasks = [0, 1, 2].map((i) => createTask({ projectKey: f.projectKey, title: `t${i}`, urgency: "now", importance: "must" }, USER));
    getDb().query("UPDATE tasks SET rank = ? WHERE id = ?").run(1, tasks[0]!.id);
    getDb().query("UPDATE tasks SET rank = ? WHERE id = ?").run(1 + 1e-9, tasks[1]!.id);
    const moved = reorderTask(tasks[2]!.id, { afterId: tasks[0]!.id }, 1, USER);
    expect(moved.rank).toBe(1.5);
    expect(listTasks({ projectKeys: [f.projectKey] }).map((t) => t.title)).toEqual(["t0", "t2", "t1"]);
    expect(getTask(tasks[1]!.id)!.revision).toBe(1);
  });

  it("filters by type, group, member, tag and text", () => {
    createTask({ projectKey: f.projectKey, title: "Reply to Acme", type: "reply", tags: ["rti"], waitingOnMemberId: "me" }, USER);
    const done = createTask({ projectKey: f.projectKey, title: "Old" }, USER);
    closeTask(done.id, {}, 1, USER);
    expect(listTasks({ types: ["reply"] })).toHaveLength(1);
    expect(listTasks({ tag: "rti" })).toHaveLength(1);
    expect(listTasks({ memberId: "me" })).toHaveLength(1);
    expect(listTasks({ text: "acme" })).toHaveLength(1);
    expect(listTasks({})).toHaveLength(1);
    expect(listTasks({ baseGroups: ["closed"] }).map((t) => t.title)).toEqual(["Old"]);
    setTasksEnabled(PROJECT_PATH, false, USER);
    expect(listTasks({})).toHaveLength(0);
  });
});

describe("handed-off work", () => {
  it("is handed off only to a chat that is not the manager, and needs checking until it has a result", () => {
    getDb().query("INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at) VALUES (?, ?, 'mgr-1', 'claude', 'user', 1)")
      .run(f.projectKey, PROJECT_PATH);
    const t = createTask({ projectKey: f.projectKey, title: "Delegated" }, USER);
    const toManager = updateTask(t.id, { workingSessionId: "mgr-1" }, 1, USER);
    expect(toManager.handedOffAt).toBeNull();
    expect(listTasksNeedingCheck()).toHaveLength(0);
    const toChild = updateTask(t.id, { workingSessionId: "child-1" }, 2, MANAGER);
    expect(toChild.handedOffAt).not.toBeNull();
    expect(listTasksNeedingCheck(f.projectKey)).toMatchObject([{ task: { id: t.id }, check: null, intervalMin: 30 }]);
    updateTask(t.id, { result: { text: "done" } }, 3, MANAGER);
    expect(listTasksNeedingCheck()).toHaveLength(0);
  });
});
