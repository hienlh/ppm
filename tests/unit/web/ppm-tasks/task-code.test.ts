/**
 * A task's code where its title is shown, and finding a task by that code: `#82` inside its own
 * project's view, `alpha/82` in a view that spans projects; a search for `#82`, `alpha/82` (any
 * case, `alpha/#82` too) shows and opens that one task, whatever filter is on; bare digits and
 * anything malformed stay an ordinary title search.
 */
import { describe, expect, it } from "bun:test";
import { matchesTaskCode, parseTaskCodeQuery, taskCode } from "../../../../src/shared/ppm-tasks-refs.ts";
import { listQueryFor, visibleTasks } from "../../../../src/web/lib/ppm-tasks/task-list-view.ts";
import { tasksMatchingCode } from "../../../../src/web/lib/ppm-tasks/task-code-lookup.ts";
import { taskChipLabel } from "../../../../src/web/lib/ppm-tasks/composer-task-chip-logic.ts";
import { EMPTY_FILTERS } from "../../../../src/web/stores/ppm-tasks-view-store.ts";
import { taskDto } from "./task-fixture.ts";

describe("taskCode", () => {
  it("is #N in the task's own project and project/N anywhere else", () => {
    const t = { number: 82, project: "alpha" };
    expect(taskCode(t, "alpha")).toBe("#82");
    expect(taskCode(t, null)).toBe("alpha/82");
    expect(taskCode(t, "beta")).toBe("alpha/82");
    // A project's name is compared as written: another spelling is another project.
    expect(taskCode(t, "Alpha")).toBe("alpha/82");
  });

  it("names the code in the composer chip's label the same way", () => {
    const chip = { number: 12, title: "Fix login", project: "alpha" };
    expect(taskChipLabel(chip, "alpha")).toBe("Task #12 · Fix login");
    expect(taskChipLabel(chip, "beta")).toBe("Task alpha/12 · Fix login");
    expect(taskChipLabel(chip)).toBe("Task alpha/12 · Fix login");
    expect(taskChipLabel({ number: 12, title: "Fix login" })).toBe("Task #12 · Fix login");
  });
});

describe("parseTaskCodeQuery", () => {
  it("reads #N, project/N and project/#N, with spaces around and in any case", () => {
    expect(parseTaskCodeQuery("#82")).toEqual({ project: null, number: 82 });
    expect(parseTaskCodeQuery("  #82 ")).toEqual({ project: null, number: 82 });
    expect(parseTaskCodeQuery("alpha/82")).toEqual({ project: "alpha", number: 82 });
    expect(parseTaskCodeQuery("ALPHA/82")).toEqual({ project: "ALPHA", number: 82 });
    expect(parseTaskCodeQuery("alpha/#82")).toEqual({ project: "alpha", number: 82 });
    expect(parseTaskCodeQuery("nxsys-workspace.v2/7")).toEqual({ project: "nxsys-workspace.v2", number: 7 });
  });

  it("leaves bare digits and anything malformed to the title search", () => {
    for (const q of ["82", "", "#", "#0", "#-1", "#abc", "#82x", "# 82", "alpha/", "alpha/x", "/82", "alpha/82/3", "a b/3", "fix #82", "#1234567890"]) {
      expect([q, parseTaskCodeQuery(q)]).toEqual([q, null]);
    }
  });

  it("matches a task by number, and by project without case", () => {
    const t = { number: 82, project: "Nxsys" };
    expect(matchesTaskCode(t, parseTaskCodeQuery("#82")!)).toBe(true);
    expect(matchesTaskCode(t, parseTaskCodeQuery("nxsys/82")!)).toBe(true);
    expect(matchesTaskCode(t, parseTaskCodeQuery("NXSYS/82")!)).toBe(true);
    expect(matchesTaskCode(t, parseTaskCodeQuery("nxsys/8")!)).toBe(false);
    expect(matchesTaskCode(t, parseTaskCodeQuery("ppm/82")!)).toBe(false);
  });
});

describe("search by code in the task list", () => {
  const a82 = taskDto({ project: "alpha", number: 82, title: "Pay run" });
  const a8 = taskDto({ project: "alpha", number: 8, title: "Mentions 82 in its title" });
  const b82 = taskDto({ project: "beta", number: 82, title: "Beta's 82" });
  const closed = taskDto({ project: "alpha", number: 5, title: "Done one", baseGroup: "closed", closedAs: "done" });
  const gone = taskDto({ project: "alpha", number: 6, deletedAt: 5 });

  it("asks the server for the whole scope, filters and text left out", () => {
    const filters = { ...EMPTY_FILTERS, groups: ["active" as const], tag: "billing" };
    expect(listQueryFor("project", "alpha", filters, "#82")).toEqual({ project: "alpha", closed: true });
    expect(listQueryFor("all", null, filters, "beta/82")).toEqual({ project: "all", closed: true });
    // Not a code: still a title search with the filters on.
    expect(listQueryFor("project", "alpha", EMPTY_FILTERS, "82")).toEqual({ project: "alpha", q: "82", closed: true });
  });

  it("shows only the task the code names, closed or not, whatever the filters say", () => {
    const all = [a82, a8, b82, closed, gone];
    const filters = { ...EMPTY_FILTERS, groups: ["active" as const] };
    expect(visibleTasks(all, filters, [], "project", "#82")).toEqual([a82, b82]);
    expect(visibleTasks(all, filters, ["beta"], "all", "Beta/82")).toEqual([b82]);
    expect(visibleTasks(all, EMPTY_FILTERS, [], "project", "#5")).toEqual([closed]);
    expect(visibleTasks(all, EMPTY_FILTERS, [], "project", "#6")).toEqual([]);
    expect(visibleTasks(all, EMPTY_FILTERS, [], "project", "#999")).toEqual([]);
  });

  it("takes #N to mean the project in view; only the palette falls back to other projects", () => {
    const all = [a82, b82];
    expect(tasksMatchingCode(all, parseTaskCodeQuery("#82")!, "alpha")).toEqual([a82]);
    expect(tasksMatchingCode(all, parseTaskCodeQuery("#82")!, "beta")).toEqual([b82]);
    expect(tasksMatchingCode(all, parseTaskCodeQuery("#82")!, null)).toEqual([a82, b82]);
    expect(tasksMatchingCode(all, parseTaskCodeQuery("#82")!, "gamma")).toEqual([]);
    expect(tasksMatchingCode(all, parseTaskCodeQuery("#82")!, "gamma", { anywhere: true })).toEqual([a82, b82]);
    expect(tasksMatchingCode(all, parseTaskCodeQuery("#82")!, "alpha", { anywhere: true })).toEqual([a82]);
    expect(tasksMatchingCode(all, parseTaskCodeQuery("beta/82")!, "alpha")).toEqual([b82]);
    expect(tasksMatchingCode([gone], parseTaskCodeQuery("#6")!, "alpha")).toEqual([]);
  });
});
