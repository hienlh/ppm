/**
 * The phone row's long-press sheet: the task's own project's statuses (in the project's order),
 * the current one highlighted, a pick closing the sheet; Urgency opening its four values in
 * place; Reorder moving only within the task's cell. The press itself: a timer disarmed by
 * `touchcancel` (a scroll never opens the sheet), and the tap after a long-press swallowed.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";
import { taskDto } from "./task-fixture.ts";
import type { TaskDto, TaskProjectSettings } from "../../../../src/shared/ppm-tasks-api.ts";

afterAll(uninstallDom);

const { act } = await import("react");
const { TaskRowActionSheet } = await import("../../../../src/web/components/ppm-tasks/mobile/task-row-action-sheet");
const { cellNeighbours } = await import("../../../../src/web/components/ppm-tasks/mobile/task-list-mobile");
const { statusMove } = await import("../../../../src/web/components/ppm-tasks/mobile/task-status-change");
const { TaskRowMobile } = await import("../../../../src/web/components/ppm-tasks/mobile/task-row-mobile");
const { LONG_PRESS_MS } = await import("../../../../src/web/components/ppm-tasks/mobile/use-task-row-long-press");
const { groupTasks } = await import("../../../../src/web/lib/ppm-tasks/task-list-view");

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const status = (id: string, name: string, baseGroup: TaskProjectSettings["statuses"][number]["baseGroup"], position: number, closedAs: "done" | "dropped" | null = null) =>
  ({ id, projectKey: "k-alpha", name, baseGroup, closedAs, position });
const STATUSES = [
  status("review", "In review", "waiting", 3),
  status("todo", "To do", "not_started", 1),
  status("doing", "In progress", "active", 2),
  status("done", "Done", "closed", 4, "done"),
  status("dropped", "Dropped", "closed", 5, "dropped"),
];

const noop = () => {};
function sheet(task: TaskDto | null, calls: string[] = []) {
  return (
    <TaskRowActionSheet task={task} statuses={STATUSES} neighbours={{ up: null, down: null }} hasManager={false}
      onClose={() => calls.push("close")} onStatus={(_t, id) => calls.push(`status:${id}`)} onUrgency={(_t, u) => calls.push(`urgency:${u}`)}
      onReorder={noop} onAskManager={noop} />
  );
}

describe("TaskRowActionSheet", () => {
  it("offers the project's own statuses in its order, the current one highlighted", async () => {
    const task = taskDto({ project: "alpha", statusId: "doing", statusName: "In progress", baseGroup: "active" });
    view = await mount(sheet(task));
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-task-status-grid] button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["To do", "In progress", "In review", "Done", "Dropped"]);
    expect(buttons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.statusId)).toEqual(["doing"]);
    expect(document.querySelector("[data-task-status-grid]")!.textContent).toContain("Move to · alpha statuses");
  });

  it("closes and moves on a pick; Urgency opens its four values in place", async () => {
    const calls: string[] = [];
    const task = taskDto({ statusId: "todo", urgency: "today" });
    view = await mount(sheet(task, calls));
    await click(document.querySelector("[data-status-id='review']"));
    expect(calls).toEqual(["close", "status:review"]);

    calls.length = 0;
    await view.rerender(sheet(task, calls));
    await click([...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Urgency"))!);
    const urgency = [...document.querySelectorAll<HTMLButtonElement>("[role=group][aria-label=Urgency] button")];
    expect(urgency.map((b) => b.textContent)).toEqual(["Now", "Today", "This week", "Later"]);
    expect(urgency.find((b) => b.getAttribute("aria-pressed") === "true")!.textContent).toBe("Today");
    await click(urgency[0]!);
    expect(calls).toEqual(["close", "urgency:now"]);
  });

  it("is closed without a task", async () => {
    view = await mount(sheet(null));
    expect(document.querySelector("[data-task-action-sheet]")).toBeNull();
  });
});

describe("Reorder and status moves", () => {
  it("moves only within the task's cell (same project, urgency and importance)", () => {
    const a = taskDto({ urgency: "now", importance: "must", rank: 1 });
    const other = taskDto({ urgency: "now", importance: "should", rank: 2 });
    const b = taskDto({ urgency: "now", importance: "must", rank: 3 });
    const groups = groupTasks([a, other, b], new Set());
    expect(cellNeighbours(groups, a)).toEqual({ up: null, down: b });
    expect(cellNeighbours(groups, b)).toEqual({ up: a, down: null });
    expect(cellNeighbours(groups, other)).toEqual({ up: null, down: null });
  });

  it("closes on a closed status, reopens out of one, else updates", () => {
    expect(statusMove({ statusId: "todo", baseGroup: "not_started" }, "done", STATUSES)).toBe("close");
    expect(statusMove({ statusId: "done", baseGroup: "closed" }, "doing", STATUSES)).toBe("reopen");
    expect(statusMove({ statusId: "todo", baseGroup: "not_started" }, "doing", STATUSES)).toBe("update");
    expect(statusMove({ statusId: "todo", baseGroup: "not_started" }, "todo", STATUSES)).toBe("none");
  });
});

describe("Long-press on a phone row", () => {
  const touch = (type: string, el: Element, y = 10) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX: 10, clientY: y }] });
    el.dispatchEvent(e);
  };
  const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

  function row(task: TaskDto, calls: string[]) {
    return <TaskRowMobile task={task} depth={0} selected={false} showProject={false}
      onOpen={() => calls.push("open")} onActions={() => calls.push("actions")} onOpenChat={noop} onStartChat={noop} />;
  }

  it("opens the sheet after a held press, and swallows the tap that follows", async () => {
    const calls: string[] = [];
    view = await mount(row(taskDto(), calls));
    const el = document.querySelector("[data-task-row]")!;
    await act(async () => { touch("touchstart", el); });
    await wait(LONG_PRESS_MS + 60);
    await act(async () => { touch("touchend", el); });
    await click(el);
    expect(calls).toEqual(["actions"]);
    await click(el);
    expect(calls).toEqual(["actions", "open"]);
  });

  it("never opens the sheet once the browser takes the press for a scroll (touchcancel)", async () => {
    const calls: string[] = [];
    view = await mount(row(taskDto(), calls));
    const el = document.querySelector("[data-task-row]")!;
    await act(async () => { touch("touchstart", el); touch("touchcancel", el); });
    await wait(LONG_PRESS_MS + 60);
    await act(async () => { touch("touchstart", el); touch("touchmove", el, 40); });
    await wait(LONG_PRESS_MS + 60);
    expect(calls).toEqual([]);
  });
});
