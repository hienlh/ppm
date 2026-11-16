/**
 * The Tasks list: Now / Today / This week / Later by effective urgency in "what to do first"
 * order, children under an expanded parent only, child progress counted over closed children too,
 * the client-side filters, and what a drag asks the server for.
 */
import { describe, expect, it } from "bun:test";
import {
  childProgress, countingQueryFor, dropIsNoop, groupTasks, listQueryFor, planDrop, visibleTasks,
} from "../../../../src/web/lib/ppm-tasks/task-list-view.ts";
import { EMPTY_FILTERS } from "../../../../src/web/stores/ppm-tasks-view-store.ts";
import { taskDto } from "./task-fixture.ts";

describe("groupTasks", () => {
  it("groups by effective urgency, most important first inside a group", () => {
    const a = taskDto({ title: "a", urgency: "later", effectiveUrgency: "now", urgencyRaised: true });
    const b = taskDto({ title: "b", urgency: "now", importance: "nice" });
    const c = taskDto({ title: "c", urgency: "week" });
    const groups = groupTasks([c, b, a], new Set());
    expect(groups.map((g) => g.urgency)).toEqual(["now", "today", "week", "later"]);
    expect(groups[0]!.rows.map((r) => r.task.title)).toEqual(["a", "b"]);
    expect(groups[2]!.count).toBe(1);
    expect(groups[3]!.rows).toHaveLength(0);
  });

  it("shows a child under its parent only while the parent is expanded", () => {
    const parent = taskDto({ title: "parent", urgency: "now" });
    const child = taskDto({ title: "child", urgency: "later", parentId: parent.id });
    const collapsed = groupTasks([parent, child], new Set());
    expect(collapsed.flatMap((g) => g.rows).map((r) => r.task.title)).toEqual(["parent"]);
    const open = groupTasks([parent, child], new Set([parent.id]));
    expect(open[0]!.rows.map((r) => [r.task.title, r.depth])).toEqual([["parent", 0], ["child", 1]]);
    expect(open[0]!.count).toBe(1);
  });

  it("a child whose parent is not in the list is a row of its own", () => {
    const orphan = taskDto({ title: "orphan", parentId: "not-listed" });
    expect(groupTasks([orphan], new Set()).flatMap((g) => g.rows).map((r) => r.task.title)).toEqual(["orphan"]);
  });
});

describe("filters", () => {
  it("asks the server for closed tasks too, for child progress", () => {
    expect(listQueryFor("project", "demo", EMPTY_FILTERS, " pay ")).toEqual({ project: "demo", q: "pay", closed: true });
    expect(listQueryFor("all", null, { ...EMPTY_FILTERS, types: ["decision"] }, "")).toEqual({ project: "all", types: ["decision"], closed: true });
    expect(listQueryFor("project", null, EMPTY_FILTERS, "")).toBeNull();
  });

  it("hides closed tasks unless the closed group is asked for, hidden projects, and a field mismatch", () => {
    const open = taskDto({ project: "a", fields: { sprint: 47 } });
    const done = taskDto({ project: "a", baseGroup: "closed", closedAs: "done" });
    const other = taskDto({ project: "b" });
    expect(visibleTasks([open, done, other], EMPTY_FILTERS, ["b"], "all")).toEqual([open]);
    expect(visibleTasks([open, done], { ...EMPTY_FILTERS, groups: ["closed"] }, [], "project")).toEqual([open, done]);
    expect(visibleTasks([open, other], { ...EMPTY_FILTERS, field: { key: "sprint", value: "47" } }, [], "project")).toEqual([open]);
  });

  it("counts closed children over every task sent", () => {
    const p = taskDto();
    const kids = [taskDto({ parentId: p.id, baseGroup: "closed", closedAs: "done" }), taskDto({ parentId: p.id }), taskDto({ parentId: p.id })];
    expect(childProgress([p, ...kids]).get(p.id)).toEqual({ done: 1, total: 3 });
  });

  it("counts children and tags over the whole scope, whatever the filters and search", () => {
    const filtered = listQueryFor("project", "demo", { ...EMPTY_FILTERS, groups: ["active"], tag: "billing", person: "me" }, "pay");
    expect(countingQueryFor("project", "demo")).toEqual({ project: "demo", closed: true });
    expect(countingQueryFor("project", "demo")).not.toEqual(filtered);
    // With no filter on it is the list's own query, so the store fetches it once.
    expect(countingQueryFor("all", null)).toEqual(listQueryFor("all", null, EMPTY_FILTERS, ""));
  });
});

describe("planDrop", () => {
  const a = taskDto({ title: "a", urgency: "now", importance: "must", rank: 1 });
  const b = taskDto({ title: "b", urgency: "now", importance: "must", rank: 2 });
  const c = taskDto({ title: "c", urgency: "now", importance: "nice", rank: 1 });
  const rows = [a, b, c];

  it("reorders next to the nearest task of the same cell", () => {
    expect(planDrop(b, "now", rows, 0)).toEqual({ kind: "reorder", to: { beforeId: a.id } });
    expect(planDrop(a, "now", rows, 2)).toEqual({ kind: "reorder", to: { afterId: b.id } });
  });

  it("refuses a reorder with no neighbour of its cell, saying why", () => {
    const plan = planDrop(c, "now", rows, 0);
    expect(plan.kind).toBe("none");
  });

  it("dropping into another group changes the urgency", () => {
    expect(planDrop(a, "later", [], 0)).toEqual({ kind: "urgency", urgency: "later" });
  });

  it("a task the due date raised cannot be dropped back to its stored urgency", () => {
    const raised = taskDto({ urgency: "later", effectiveUrgency: "today", urgencyRaised: true });
    expect(planDrop(raised, "later", [], 0).kind).toBe("none");
  });

  it("a drop where the task already is writes nothing", () => {
    expect(dropIsNoop(a, rows, { kind: "reorder", to: { beforeId: b.id } })).toBe(true);
    expect(dropIsNoop(b, rows, { kind: "reorder", to: { beforeId: a.id } })).toBe(false);
  });
});
