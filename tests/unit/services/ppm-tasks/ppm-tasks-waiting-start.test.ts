/**
 * How long a waiting task has waited counts from when its status moved into Waiting, read from
 * the task's history, so a task in Waiting with nobody named still says "for 2 days". The wire
 * carries the waited-on member's name for views with no member list, and the Telegram `/tasks`
 * card words the wait the same way the app does.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { createTask, getTask, listTasks, updateTask } from "../../../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { addMember } from "../../../../src/services/ppm-tasks/ppm-tasks-project-config.ts";
import { toTaskDtos } from "../../../../src/server/routes/ppm-tasks-dto.ts";
import { taskFacts } from "../../../../src/services/assistant-telegram/assistant-telegram-tasks-deck.ts";
import { freshProject, USER, type Fixture } from "./ppm-tasks-fixture.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 10, 9);

let f: Fixture;
beforeEach(() => { f = freshProject(); });

describe("waitingStartedAt", () => {
  it("is the moment the status moved into Waiting, whether or not anyone is named", () => {
    const t = createTask({ projectKey: f.projectKey, title: "Ask legal" }, USER, T0);
    updateTask(t.id, { statusId: f.status("In progress").id }, 1, USER, T0 + DAY);
    updateTask(t.id, { statusId: f.status("Waiting").id }, 2, USER, T0 + 3 * DAY);
    const later = updateTask(t.id, { notes: "chased again" }, 3, USER, T0 + 4 * DAY);
    expect(later.waitingStartedAt).toBe(T0 + 3 * DAY);
    expect(later.waitingSince).toBeNull();
    expect(getTask(t.id)!.waitingStartedAt).toBe(T0 + 3 * DAY);
    expect(listTasks({ projectKeys: [f.projectKey] }).find((x) => x.id === t.id)!.waitingStartedAt).toBe(T0 + 3 * DAY);
  });

  it("counts from creation for a task created in Waiting, and resets when it leaves and comes back", () => {
    const t = createTask({ projectKey: f.projectKey, title: "Wait for invoice", statusId: f.status("Waiting").id }, USER, T0);
    expect(getTask(t.id)!.waitingStartedAt).toBe(T0);
    updateTask(t.id, { statusId: f.status("In progress").id }, 1, USER, T0 + DAY);
    expect(getTask(t.id)!.waitingStartedAt).toBeNull();
    updateTask(t.id, { statusId: f.status("Waiting").id }, 2, USER, T0 + 2 * DAY);
    expect(getTask(t.id)!.waitingStartedAt).toBe(T0 + 2 * DAY);
  });

  it("is null for a task that does not wait", () => {
    const t = createTask({ projectKey: f.projectKey, title: "Plain" }, USER, T0);
    expect(getTask(t.id)!.waitingStartedAt).toBeNull();
  });
});

describe("what leaves the server", () => {
  it("names the member waited on for the wire, and nobody for the user or no one", () => {
    const viet = addMember(f.projectKey, { name: "Việt" }, USER);
    const a = createTask({ projectKey: f.projectKey, title: "A", statusId: f.status("Waiting").id, waitingOnMemberId: viet.id }, USER, T0);
    const b = createTask({ projectKey: f.projectKey, title: "B", statusId: f.status("Waiting").id, waitingOnMemberId: "me" }, USER, T0);
    const c = createTask({ projectKey: f.projectKey, title: "C", statusId: f.status("Waiting").id }, USER, T0);
    const dtos = toTaskDtos([getTask(a.id)!, getTask(b.id)!, getTask(c.id)!]);
    expect(dtos.map((d) => d.waitingOnName)).toEqual(["Việt", null, null]);
  });

  it("gives the Telegram card the same wait the app shows", () => {
    const viet = addMember(f.projectKey, { name: "Việt" }, USER);
    const mine = createTask({ projectKey: f.projectKey, title: "Sign off", statusId: f.status("Waiting").id, waitingOnMemberId: "me", dueDate: "2026-11-18" }, USER, T0);
    const theirs = createTask({ projectKey: f.projectKey, title: "Review", statusId: f.status("Waiting").id, waitingOnMemberId: viet.id }, USER, T0);
    expect(taskFacts(getTask(mine.id)!).waiting).toEqual({ label: "Waiting on you", name: "you", mine: true, until: { kind: "due", dueDate: "2026-11-18" } });
    expect(taskFacts(getTask(theirs.id)!).waiting).toMatchObject({ label: "Waiting on Việt", mine: false, until: { kind: "for", since: T0 } });
    const plain = createTask({ projectKey: f.projectKey, title: "Plain" }, USER, T0);
    expect(taskFacts(getTask(plain.id)!).waiting).toBeNull();
  });
});
