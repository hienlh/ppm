import { beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { getDb } from "../../../../src/services/db.service.ts";
import { createTask, getTask, listTasks, softDeleteTask, updateTask } from "../../../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { addStatus, deleteStatus } from "../../../../src/services/ppm-tasks/ppm-tasks-project-config.ts";
import { setTasksEnabled } from "../../../../src/services/ppm-tasks/ppm-tasks-projects.service.ts";
import { taskHistory, undoChange, undoRefusal, historyRow } from "../../../../src/services/ppm-tasks/ppm-tasks-history.ts";
import { compactHistory } from "../../../../src/services/ppm-tasks/ppm-tasks-compaction.ts";
import { ASSISTANT, freshProject, MANAGER, PROJECT_PATH, USER, type Fixture } from "./ppm-tasks-fixture.ts";

let f: Fixture;
beforeEach(() => { f = freshProject(); });
const DAY = 86_400_000;

describe("undo", () => {
  it("undoes an AI change and records the undo", () => {
    const t = createTask({ projectKey: f.projectKey, title: "Pension", urgency: "today" }, USER);
    updateTask(t.id, { urgency: "now", why: "deadline" }, 1, MANAGER);
    const change = taskHistory(t.id)[0]!;
    const undoId = undoChange(change.id, USER);
    expect(getTask(t.id)).toMatchObject({ urgency: "today", why: null, revision: 3 });
    expect(historyRow(change.id)!.undoneBy).toBe(undoId);
    expect(historyRow(undoId)).toMatchObject({ kind: "undo", undoOf: change.id, actor: { kind: "user" } });
    expect(() => undoChange(change.id, USER)).toThrow(/already undone/);
  });

  it("refuses a user's change, an undo, and a change older than 90 days", () => {
    const t = createTask({ projectKey: f.projectKey, title: "x" }, USER);
    updateTask(t.id, { title: "by user" }, 1, USER);
    expect(() => undoChange(taskHistory(t.id)[0]!.id, USER)).toThrow(/Only changes made by AI/);
    updateTask(t.id, { title: "by ai" }, 2, ASSISTANT);
    const ai = taskHistory(t.id)[0]!;
    expect(undoRefusal(ai, ai.at + 91 * DAY)).toMatch(/older than 90 days/);
    const undoId = undoChange(ai.id, USER);
    expect(undoRefusal(historyRow(undoId)!, Date.now())).toMatch(/cannot itself be undone/);
  });

  it("refuses when a field it touched has changed since", () => {
    const t = createTask({ projectKey: f.projectKey, title: "x" }, USER);
    updateTask(t.id, { title: "ai title", why: "ai why" }, 1, MANAGER);
    const ai = taskHistory(t.id)[0]!;
    updateTask(t.id, { why: "my why" }, 2, USER);
    expect(() => undoChange(ai.id, USER)).toThrow(/why changed since/);
    expect(getTask(t.id)).toMatchObject({ title: "ai title", why: "my why" });
  });

  it("undoes only its own custom field keys", () => {
    const t = createTask({ projectKey: f.projectKey, title: "x", fields: { A: "1" } }, USER);
    updateTask(t.id, { fields: { B: "2" } }, 1, MANAGER);
    const ai = taskHistory(t.id)[0]!;
    updateTask(t.id, { fields: { A: "changed" } }, 2, USER);
    undoChange(ai.id, USER);
    expect(getTask(t.id)!.fields).toEqual({ A: "changed" });
  });

  it("undoing an AI create soft-deletes only while nothing else changed the task", () => {
    const kept = createTask({ projectKey: f.projectKey, title: "touched" }, MANAGER);
    updateTask(kept.id, { title: "touched by me" }, 1, USER);
    expect(() => undoChange(taskHistory(kept.id).at(-1)!.id, USER)).toThrow(/changed after it was created/);
    const t = createTask({ projectKey: f.projectKey, title: "mistake" }, MANAGER);
    undoChange(taskHistory(t.id)[0]!.id, USER);
    expect(getTask(t.id)!.deletedAt).not.toBeNull();
    expect(listTasks({}).map((x) => x.title)).toEqual(["touched by me"]);
  });

  it("undoes a status move and its closed time", () => {
    const t = createTask({ projectKey: f.projectKey, title: "x" }, USER);
    updateTask(t.id, { statusId: f.status("Done").id }, 1, MANAGER);
    expect(getTask(t.id)!.closedAt).not.toBeNull();
    undoChange(taskHistory(t.id)[0]!.id, USER);
    expect(getTask(t.id)).toMatchObject({ statusId: f.status("To do").id, closedAt: null });
  });
});

describe("undo, guarded", () => {
  it("brings back a task the AI deleted", () => {
    const t = createTask({ projectKey: f.projectKey, title: "deleted by ai" }, USER);
    softDeleteTask(t.id, 1, ASSISTANT);
    undoChange(taskHistory(t.id)[0]!.id, USER);
    expect(getTask(t.id)!.deletedAt).toBeNull();
    expect(listTasks({}).map((x) => x.title)).toEqual(["deleted by ai"]);
  });

  it("refuses to put back a status that no longer exists", () => {
    const review = addStatus(f.projectKey, { name: "Review", baseGroup: "active" }, USER);
    const t = createTask({ projectKey: f.projectKey, title: "x", statusId: review.id }, USER);
    updateTask(t.id, { statusId: f.status("In progress").id }, 1, MANAGER);
    const ai = taskHistory(t.id)[0]!;
    deleteStatus(review.id, null, USER);
    expect(() => undoChange(ai.id, USER)).toThrow(/Cannot undo: No status/);
    expect(getTask(t.id)!.statusId).toBe(f.status("In progress").id);
  });

  it("refuses to undo in a project whose tasks are switched off", () => {
    const t = createTask({ projectKey: f.projectKey, title: "x" }, USER);
    updateTask(t.id, { why: "ai" }, 1, MANAGER);
    setTasksEnabled(PROJECT_PATH, false, USER);
    expect(() => undoChange(taskHistory(t.id)[0]!.id, USER)).toThrow(/switched off/);
  });
});

describe("compaction", () => {
  it("drops an undone key event together with its undo once both are old", () => {
    const t = createTask({ projectKey: f.projectKey, title: "x" }, USER);
    updateTask(t.id, { statusId: f.status("Done").id }, 1, MANAGER);
    undoChange(taskHistory(t.id)[0]!.id, USER);
    const now = Date.now();
    getDb().query("UPDATE task_history SET at = ?").run(now - 91 * DAY);
    compactHistory(now);
    expect(taskHistory(t.id).map((h) => h.kind)).toEqual(["created"]);
  });

  it("keeps only key events past 90 days", () => {
    const t = createTask({ projectKey: f.projectKey, title: "old" }, USER);
    updateTask(t.id, { why: "detail" }, 1, MANAGER);
    updateTask(t.id, { statusId: f.status("In progress").id }, 2, MANAGER);
    updateTask(t.id, { statusId: f.status("Done").id }, 3, MANAGER);
    updateTask(t.id, { statusId: f.status("To do").id }, 4, MANAGER);
    updateTask(t.id, { result: { text: "r" } }, 5, MANAGER);
    const now = Date.now();
    getDb().query("UPDATE task_history SET at = ?").run(now - 91 * DAY);
    const fresh = createTask({ projectKey: f.projectKey, title: "new" }, USER);
    updateTask(fresh.id, { why: "recent" }, 1, USER);
    expect(compactHistory(now)).toBe(3);
    expect(taskHistory(t.id).map((h) => h.kind).sort()).toEqual(["closed", "created", "reopened", "status"]);
    expect(taskHistory(fresh.id)).toHaveLength(2);
  });
});
