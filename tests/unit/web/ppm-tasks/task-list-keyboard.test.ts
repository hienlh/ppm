/** Arrow keys walk the Tasks list in screen order, stopping at the ends. */
import { describe, expect, it } from "bun:test";
import { flatRows, groupTasks, stepSelection } from "../../../../src/web/lib/ppm-tasks/task-list-view.ts";
import { taskDto } from "./task-fixture.ts";

const now = taskDto({ title: "now", urgency: "now" });
const today = taskDto({ title: "today", urgency: "today" });
const later = taskDto({ title: "later", urgency: "later" });
const rows = flatRows(groupTasks([later, today, now], new Set()));

describe("stepSelection", () => {
  it("walks the rows across groups in screen order", () => {
    expect(rows.map((t) => t.title)).toEqual(["now", "today", "later"]);
    expect(stepSelection(rows, now.id, 1)).toBe(today.id);
    expect(stepSelection(rows, later.id, -1)).toBe(today.id);
  });

  it("stays put at either end", () => {
    expect(stepSelection(rows, later.id, 1)).toBe(later.id);
    expect(stepSelection(rows, now.id, -1)).toBe(now.id);
  });

  it("starts at the first row going down and the last going up", () => {
    expect(stepSelection(rows, null, 1)).toBe(now.id);
    expect(stepSelection(rows, "gone", -1)).toBe(later.id);
    expect(stepSelection([], null, 1)).toBeNull();
  });

  it("an expanded parent's children are stepped through too", () => {
    const parent = taskDto({ urgency: "now" });
    const child = taskDto({ parentId: parent.id, urgency: "now" });
    const withKids = flatRows(groupTasks([parent, child], new Set([parent.id])));
    expect(stepSelection(withKids, parent.id, 1)).toBe(child.id);
  });
});
