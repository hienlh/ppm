import { beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { getDb, openTestDb, setDb } from "../../../../src/services/db.service.ts";
import { projectKey as keyOf } from "../../../../src/services/project-name-for-path.ts";
import {
  enableOnManagerAssigned, getTaskProject, isTasksEnabled, setCheckInterval, setTasksEnabled,
} from "../../../../src/services/ppm-tasks/ppm-tasks-projects.service.ts";
import {
  addMember, addStatus, deleteFieldDef, deleteStatus, listFieldDefs, listMembers, listStatuses, updateMember,
  updateStatus, upsertFieldDef,
} from "../../../../src/services/ppm-tasks/ppm-tasks-project-config.ts";
import { createTask, getTask } from "../../../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { taskHistory } from "../../../../src/services/ppm-tasks/ppm-tasks-history.ts";
import { pendingManagerNews } from "../../../../src/services/ppm-tasks/ppm-tasks-deliver.ts";
import { freshProject, MANAGER, PROJECT_PATH, USER, type Fixture } from "./ppm-tasks-fixture.ts";

describe("project switch", () => {
  beforeEach(() => setDb(openTestDb()));

  it("is off by default, seeds the default statuses on first enable, and off hides without deleting", () => {
    const key = keyOf(PROJECT_PATH);
    expect(isTasksEnabled(key)).toBe(false);
    setTasksEnabled(PROJECT_PATH, true, USER);
    expect(listStatuses(key).map((s) => [s.name, s.baseGroup, s.closedAs])).toEqual([
      ["To do", "not_started", null], ["In progress", "active", null], ["Waiting", "waiting", null],
      ["Done", "closed", "done"], ["Dropped", "closed", "dropped"],
    ]);
    const t = createTask({ projectKey: key, title: "kept" }, USER);
    setTasksEnabled(PROJECT_PATH, false, USER);
    expect(getTask(t.id)).not.toBeNull();
    expect(getTaskProject(key)).toMatchObject({ enabled: false, enabledBy: "user" });
  });

  it("turns on when a manager is assigned and starts the manager's news from now", () => {
    const key = keyOf(PROJECT_PATH);
    setTasksEnabled(PROJECT_PATH, true, USER);
    const t = createTask({ projectKey: key, title: "old news" }, USER);
    setTasksEnabled(PROJECT_PATH, false, USER);
    enableOnManagerAssigned(key, PROJECT_PATH);
    expect(getTaskProject(key)).toMatchObject({ enabled: true, enabledBy: "manager_assign" });
    expect(pendingManagerNews(key).history).toHaveLength(0);
    expect(taskHistory(t.id)).toHaveLength(1);
  });

  it("bounds the check interval", () => {
    setTasksEnabled(PROJECT_PATH, true, USER);
    const key = keyOf(PROJECT_PATH);
    expect(getTaskProject(key)!.checkIntervalMin).toBe(30);
    expect(setCheckInterval(key, 45, USER).checkIntervalMin).toBe(45);
    expect(() => setCheckInterval(key, 4, USER)).toThrow(/5 to 240/);
    expect(() => setCheckInterval(key, 241, USER)).toThrow(/5 to 240/);
  });
});

describe("statuses, members, fields", () => {
  let f: Fixture;
  beforeEach(() => { f = freshProject(); });

  it("keeps at least one not-started and one closed status", () => {
    expect(() => deleteStatus(f.status("To do").id, null, USER)).toThrow(/not-started/);
    deleteStatus(f.status("Dropped").id, null, USER);
    expect(() => deleteStatus(f.status("Done").id, null, USER)).toThrow(/closed status/);
    expect(() => updateStatus(f.status("Done").id, { baseGroup: "active" }, USER)).toThrow(/closed status/);
    expect(listStatuses(f.projectKey).map((s) => s.name)).toEqual(["To do", "In progress", "Waiting", "Done"]);
  });

  it("moves a used status's tasks to the replacement, with history", () => {
    const review = addStatus(f.projectKey, { name: "In review", baseGroup: "active" }, USER);
    expect(() => addStatus(f.projectKey, { name: "in review", baseGroup: "active" }, USER)).toThrow(/already exists/);
    const t = createTask({ projectKey: f.projectKey, title: "x", statusId: review.id }, USER);
    expect(() => updateStatus(review.id, { baseGroup: "waiting" }, USER)).toThrow(/Tasks use this status/);
    expect(() => deleteStatus(review.id, null, USER)).toThrow(/name another status/);
    deleteStatus(review.id, f.status("In progress").id, MANAGER);
    expect(getTask(t.id)).toMatchObject({ statusId: f.status("In progress").id, revision: 2 });
    expect(taskHistory(t.id)[0]).toMatchObject({ kind: "status", actor: { kind: "manager" } });
    expect(updateStatus(f.status("Waiting").id, { name: "Blocked" }, USER).name).toBe("Blocked");
  });

  it("adds, edits and archives members", () => {
    const m = addMember(f.projectKey, { name: "Linh", githubLogin: "linh-dev" }, USER);
    expect(m).toMatchObject({ name: "Linh", githubLogin: "linh-dev", jiraAccountId: null });
    const t = createTask({ projectKey: f.projectKey, title: "x", assigneeMemberId: m.id }, USER);
    expect(t.assigneeMemberId).toBe(m.id);
    expect(() => createTask({ projectKey: f.projectKey, title: "y", assigneeMemberId: "nobody" }, USER)).toThrow(/no member/);
    updateMember(m.id, { archived: true }, USER);
    expect(listMembers(f.projectKey)).toHaveLength(0);
    expect(listMembers(f.projectKey, true)).toHaveLength(1);
  });

  it("defines custom fields and leaves stored values when a definition goes", () => {
    upsertFieldDef(f.projectKey, { key: "Sprint", label: "Sprint", type: "number" }, USER);
    upsertFieldDef(f.projectKey, { key: "Tier", label: "Tier", type: "select", options: ["Gold", "Silver"] }, USER);
    expect(() => upsertFieldDef(f.projectKey, { key: "Bad", label: "Bad", type: "select", options: [] }, USER)).toThrow(/1 to 50/);
    expect(listFieldDefs(f.projectKey).map((d) => d.key)).toEqual(["Sprint", "Tier"]);
    const t = createTask({ projectKey: f.projectKey, title: "x", fields: { Sprint: 47 } }, USER);
    deleteFieldDef(f.projectKey, "Sprint", USER);
    expect(getTask(t.id)!.fields).toEqual({ Sprint: 47 });
    const configRows = getDb().query("SELECT COUNT(*) AS n FROM task_history WHERE task_id IS NULL AND kind = 'project'").get() as { n: number };
    expect(configRows.n).toBeGreaterThanOrEqual(4);
  });
});
