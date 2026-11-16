/**
 * The PPM Tasks store and its pure half: "what to do first" order, a changed task folded into an
 * all-projects list (and out of a list it no longer matches), events re-reading only the lists
 * someone shows, and a stale write turned into a re-read plus one toast instead of an error.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { foldTask, groupByProject, listKey, matchesQuery, orderTasks, whatToDoFirst } from "../../../src/web/lib/ppm-tasks/ppm-tasks-list-logic.ts";
import { createPpmTasksStore, STALE_TOAST } from "../../../src/web/lib/ppm-tasks/ppm-tasks-store-core.ts";
import { StaleTaskError, typedTaskError, TasksOffError, type TaskListQuery } from "../../../src/web/lib/ppm-tasks/ppm-tasks-client.ts";
import { ApiError } from "../../../src/web/lib/api-client.ts";
import type { TaskDetailResponse, TaskDto, TaskListResponse } from "../../../src/shared/ppm-tasks-api.ts";

let seq = 0;
function dto(over: Partial<TaskDto> = {}): TaskDto {
  seq++;
  return {
    id: `t${seq}`, projectKey: `/p/${over.project ?? "demo"}`, number: seq, title: `Task ${seq}`, type: "task", statusId: "s1",
    urgency: "later", importance: "should", rank: seq, why: null, nextStep: null, notes: null, dueDate: null, tags: [],
    assigneeMemberId: null, waitingOnMemberId: null, waitingSince: null, parentId: null, workingSessionId: null, decision: null,
    fields: {}, links: [], result: null, handedOffAt: null, revision: 1, createdAt: 0, updatedAt: 0, closedAt: null, deletedAt: null,
    baseGroup: "not_started", closedAs: null, effectiveUrgency: over.urgency ?? "later", urgencyRaised: false,
    project: "demo", ref: `demo/${seq}`, statusName: "To do", workingSession: { kind: "start_chat" }, check: null,
    ...over,
  };
}

describe("list logic", () => {
  it("orders by effective urgency, then importance, then manual rank", () => {
    const a = dto({ title: "later must", effectiveUrgency: "later", importance: "must", rank: 1 });
    const b = dto({ title: "now nice", effectiveUrgency: "now", importance: "nice", rank: 1 });
    const c = dto({ title: "now must second", effectiveUrgency: "now", importance: "must", rank: 2 });
    const d = dto({ title: "now must first", effectiveUrgency: "now", importance: "must", rank: 1 });
    expect(orderTasks([a, b, c, d]).map((t) => t.title)).toEqual(["now must first", "now must second", "now nice", "later must"]);
    const closed = dto({ title: "done", effectiveUrgency: "now", importance: "must", baseGroup: "closed" });
    expect(whatToDoFirst([a, closed, d], 2).map((t) => t.title)).toEqual(["now must first", "later must"]);
  });

  it("keys a query the same whatever the order of its lists", () => {
    expect(listKey({ project: "all", types: ["reply", "decision"] })).toBe(listKey({ project: "all", types: ["decision", "reply"] }));
    expect(listKey({ project: "all", closed: true })).not.toBe(listKey({ project: "all" }));
  });

  it("folds a change into an all-projects list, re-sorted, and out when it stops matching", () => {
    const q: TaskListQuery = { project: "all" };
    const demo = dto({ project: "demo", effectiveUrgency: "today" });
    const web = dto({ project: "web", effectiveUrgency: "week" });
    let list = orderTasks([demo, web]);
    list = foldTask(list, { ...web, effectiveUrgency: "now" }, q);
    expect(list.map((t) => t.project)).toEqual(["web", "demo"]);
    const brandNew = dto({ project: "pex", effectiveUrgency: "later" });
    expect(foldTask(list, brandNew, q).map((t) => t.project)).toEqual(["web", "demo", "pex"]);
    expect(foldTask(list, { ...demo, baseGroup: "closed" }, q).map((t) => t.project)).toEqual(["web"]);
    expect(foldTask(list, { ...demo, baseGroup: "closed" }, { ...q, closed: true }).map((t) => t.project)).toEqual(["web", "demo"]);
    expect(groupByProject(list).map((g) => g.project)).toEqual(["web", "demo"]);
  });

  it("matches filters the way the server does", () => {
    const t = dto({ type: "reply", tags: ["rti"], waitingOnMemberId: "m1", notes: "Customer waits on RTI" });
    expect(matchesQuery(t, { project: "demo", types: ["reply"], tag: "rti", person: "m1", q: "rti" })).toBe(true);
    expect(matchesQuery(t, { project: "web" })).toBe(false);
    expect(matchesQuery(t, { project: "all", groups: ["active"] })).toBe(false);
    expect(matchesQuery({ ...t, deletedAt: 5 }, { project: "all" })).toBe(false);
  });
});

function fakeClient() {
  const lists: Array<TaskListQuery> = [];
  const gets: string[] = [];
  let listAnswer: TaskListResponse = { tasks: [], projects: [] };
  return {
    lists, gets,
    setList(answer: TaskListResponse) { listAnswer = answer; },
    client: {
      list: async (q: TaskListQuery) => { lists.push(q); return listAnswer; },
      get: async (id: string): Promise<TaskDetailResponse> => { gets.push(id); return { task: dto({ id }), children: [], linkStates: [] }; },
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("store", () => {
  it("applies a write to every cached list and turns a stale write into a re-read and a toast", async () => {
    const fake = fakeClient();
    const toasts: string[] = [];
    const store = createPpmTasksStore({ client: fake.client as never, toast: (m) => toasts.push(m) });
    const a = dto({ project: "demo", effectiveUrgency: "later" });
    const b = dto({ project: "web", effectiveUrgency: "week" });
    fake.setList({ tasks: [b, a], projects: [] });
    const unwatch = store.getState().watchList({ project: "all" });
    await settle();
    expect(store.getState().lists[listKey({ project: "all" })]!.data!.tasks.map((t) => t.id)).toEqual([b.id, a.id]);

    const answer = await store.getState().write(a.id, async () => ({ task: { ...a, effectiveUrgency: "now" as const, revision: 2 }, managerPrompt: true }));
    expect(answer?.managerPrompt).toBe(true);
    expect(store.getState().lists[listKey({ project: "all" })]!.data!.tasks.map((t) => t.id)).toEqual([a.id, b.id]);

    fake.lists.length = 0;
    const stale = await store.getState().write(a.id, async () => { throw new StaleTaskError("changed", 3); });
    await settle();
    expect(stale).toBeNull();
    expect(toasts).toEqual([STALE_TOAST]);
    expect(fake.lists).toEqual([{ project: "all" }]);

    await expect(store.getState().write(a.id, async () => { throw new TasksOffError("off"); })).rejects.toBeInstanceOf(TasksOffError);
    unwatch();
  });

  it("re-reads shown lists on a change and drops the ones nobody shows", async () => {
    const fake = fakeClient();
    const store = createPpmTasksStore({ client: fake.client as never, toast: () => {} });
    const stopDemo = store.getState().watchList({ project: "demo" });
    const stopWeb = store.getState().watchList({ project: "web" });
    await settle();
    stopWeb();
    fake.lists.length = 0;
    store.getState().onTasksChanged("demo", ["x"]);
    store.getState().onTasksChanged("web", ["y"]);
    await settle();
    expect(fake.lists).toEqual([{ project: "demo" }]);
    expect(store.getState().lists[listKey({ project: "web" })]).toBeUndefined();
    stopDemo();
  });

  it("re-reads a shown detail named by a change, and the parent showing it as a child", async () => {
    const fake = fakeClient();
    const store = createPpmTasksStore({ client: fake.client as never, toast: () => {} });
    store.getState().watchDetail("parent");
    await settle();
    store.setState((s) => ({ details: { ...s.details, parent: { ...s.details.parent!, data: { task: dto({ id: "parent" }), children: [dto({ id: "kid" })], linkStates: [] } } } }));
    fake.gets.length = 0;
    store.getState().onTasksChanged("demo", ["kid"]);
    await settle();
    expect(fake.gets).toEqual(["parent"]);
  });
});

describe("store ordering of answers", () => {
  it("drops an older read that lands after a newer one, and a read sent before a write", async () => {
    const answers: Array<(r: TaskListResponse) => void> = [];
    const client = { list: () => new Promise<TaskListResponse>((r) => answers.push(r)), get: async () => { throw new Error("unused"); } };
    const store = createPpmTasksStore({ client: client as never, toast: () => {} });
    const q: TaskListQuery = { project: "demo" };
    const key = listKey(q);
    store.getState().watchList(q);
    void store.getState().fetchList(q);
    const newer = dto({ title: "newer" });
    answers[1]!({ tasks: [newer], projects: [] });
    await settle();
    answers[0]!({ tasks: [dto({ title: "older" })], projects: [] });
    await settle();
    expect(store.getState().lists[key]!.data!.tasks.map((t) => t.title)).toEqual(["newer"]);

    void store.getState().fetchList(q);
    store.getState().applyTask({ ...newer, title: "written" });
    answers[2]!({ tasks: [newer], projects: [] });
    await settle();
    expect(store.getState().lists[key]!.data!.tasks.map((t) => t.title)).toEqual(["written"]);
    expect(store.getState().lists[key]!.loading).toBe(false);
  });

  it("forgets unshown lists on resync and re-reads the shown ones", async () => {
    const fake = fakeClient();
    const store = createPpmTasksStore({ client: fake.client as never, toast: () => {} });
    const stopOld = store.getState().watchList({ project: "old" });
    store.getState().watchList({ project: "shown" });
    await settle();
    stopOld();
    fake.lists.length = 0;
    store.getState().resync();
    await settle();
    expect(fake.lists).toEqual([{ project: "shown" }]);
    expect(store.getState().lists[listKey({ project: "old" })]).toBeUndefined();
  });
});

describe("client errors", () => {
  it("types the server's codes", () => {
    const stale = typedTaskError(new ApiError("changed", 409, { ok: false, code: "stale", revision: 7 }));
    expect(stale).toBeInstanceOf(StaleTaskError);
    expect((stale as StaleTaskError).revision).toBe(7);
    expect(typedTaskError(new ApiError("off", 404, { code: "tasks_off" }))).toBeInstanceOf(TasksOffError);
    const plain = new Error("network");
    expect(typedTaskError(plain)).toBe(plain);
  });
});
