/**
 * Snooze in the Tasks UI: the choices (Tomorrow, 1 week, Pick a date, Until a link changes,
 * Unsnooze) and the patch each writes; the list keeping snoozed tasks out of the urgency groups
 * and in a folded "Snoozed (N)" section instead; "Back today" and the snooze wording; and the
 * button sizes the standard sets (28px text buttons, 26px on a phone).
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { click, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";
import { taskDto } from "./task-fixture.ts";
import type { TaskDto } from "../../../../src/shared/ppm-tasks-api.ts";
import type { HistoryEntry } from "../../../../src/shared/ppm-tasks.ts";

afterAll(uninstallDom);

const { act } = await import("react");
const { isSnoozeDay, snoozeChoices, snoozedLabel, UNSNOOZE_PATCH } = await import("../../../../src/web/lib/ppm-tasks/task-snooze-choices");
const { listQueryFor, snoozedTasks, visibleTasks } = await import("../../../../src/web/lib/ppm-tasks/task-list-view");
const { listKey, matchesQuery, whatToDoFirst } = await import("../../../../src/web/lib/ppm-tasks/ppm-tasks-list-logic");
const { taskListPath } = await import("../../../../src/web/lib/ppm-tasks/ppm-tasks-client");
const { entryText } = await import("../../../../src/web/lib/ppm-tasks/task-history-text");
const { EMPTY_FILTERS, useTaskViewStore } = await import("../../../../src/web/stores/ppm-tasks-view-store");
const { TaskSnoozeOptions } = await import("../../../../src/web/components/ppm-tasks/task-snooze-options");
const { TaskSnoozedSection, UnsnoozeButton } = await import("../../../../src/web/components/ppm-tasks/task-snoozed-section");
const { snoozeBadgeText, TaskSnoozeBadge } = await import("../../../../src/web/components/ppm-tasks/kit/task-snooze-badge");
const { TaskRowActionSheet } = await import("../../../../src/web/components/ppm-tasks/mobile/task-row-action-sheet");
const { TEXT_CONTROL_HEIGHT } = await import("../../../../src/web/lib/control-size");

const TODAY = "2026-11-17";
let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const snoozedTask = (over: Partial<TaskDto> = {}) =>
  taskDto({ snoozedUntil: "2026-11-20", snoozed: true, snoozedAt: 1, ...over });

describe("the choices", () => {
  it("offer tomorrow and a week from today, a date, a link watch, and Unsnooze only while snoozed", () => {
    const plain = snoozeChoices(taskDto(), TODAY);
    expect(plain.map((c) => c.id)).toEqual(["tomorrow", "week", "date", "link"]);
    expect(plain[0]).toMatchObject({ detail: "Wed 18 Nov", patch: { snoozedUntil: "2026-11-18", snoozeUntilChange: false } });
    expect(plain[1]).toMatchObject({ detail: "Tue 24 Nov", patch: { snoozedUntil: "2026-11-24", snoozeUntilChange: false } });
    expect(plain[2]!.patch).toBeNull();
    expect(plain[3]).toMatchObject({ disabled: true, detail: "Needs a Jira or PR link" });
    const linked = snoozeChoices(snoozedTask({ links: [{ kind: "pr", ref: "a/b#1", label: null }] }), TODAY);
    expect(linked.find((c) => c.id === "link")).toMatchObject({ disabled: false, patch: { snoozedUntil: null, snoozeUntilChange: true } });
    expect(linked.at(-1)).toMatchObject({ id: "clear", label: "Unsnooze", patch: UNSNOOZE_PATCH });
  });

  it("take a picked day only after today, and say what a snooze is", () => {
    expect(isSnoozeDay("2026-11-18", TODAY)).toBe(true);
    expect(isSnoozeDay(TODAY, TODAY)).toBe(false);
    expect(isSnoozeDay("2026-11", TODAY)).toBe(false);
    expect(snoozedLabel({ snoozedUntil: "2026-11-20", snoozeUntilChange: false }, TODAY)).toBe("Snoozed until Fri 20 Nov");
    expect(snoozedLabel({ snoozedUntil: null, snoozeUntilChange: true })).toBe("Snoozed until a link changes");
    expect(snoozeBadgeText(snoozedTask(), TODAY)).toBe("Until Fri 20 Nov");
    expect(snoozeBadgeText(taskDto({ resurfacedToday: true }), TODAY)).toBe("Back today");
    expect(snoozeBadgeText(taskDto(), TODAY)).toBeNull();
  });
});

describe("the list", () => {
  const open = taskDto({ title: "open", urgency: "now" });
  const later = snoozedTask({ title: "later", snoozedUntil: "2026-12-01" });
  const sooner = snoozedTask({ title: "sooner", snoozedUntil: "2026-11-19" });
  const onLink = snoozedTask({ title: "on link", snoozedUntil: null, snoozeUntilChange: true });
  const all = [open, later, sooner, onLink];

  it("asks the server for snoozed tasks too, and a list asked without them drops them", () => {
    const q = listQueryFor("project", "demo", EMPTY_FILTERS, "")!;
    expect(q.snoozed).toBe(true);
    expect(taskListPath(q)).toContain("snoozed=1");
    expect(listKey(q)).not.toBe(listKey({ ...q, snoozed: false }));
    expect(matchesQuery(later, { project: "demo" })).toBe(false);
    expect(matchesQuery(later, { project: "demo", snoozed: true })).toBe(true);
    expect(whatToDoFirst(all).map((t) => t.title)).toEqual(["open"]);
  });

  it("keeps snoozed tasks out of the groups and lists them soonest first, a link watch last", () => {
    expect(visibleTasks(all, EMPTY_FILTERS, [], "project").map((t) => t.title)).toEqual(["open"]);
    expect(snoozedTasks(all, EMPTY_FILTERS, [], "project").map((t) => t.title)).toEqual(["sooner", "later", "on link"]);
    // Hidden projects and closed ones stay out of the section too.
    expect(snoozedTasks(all, EMPTY_FILTERS, ["demo"], "all")).toHaveLength(0);
  });

  it("shows a snoozed task found by its code, and no section then", () => {
    expect(visibleTasks(all, EMPTY_FILTERS, [], "project", `#${later.number}`).map((t) => t.title)).toEqual(["later"]);
    expect(snoozedTasks(all, EMPTY_FILTERS, [], "project", `#${later.number}`)).toHaveLength(0);
  });
});

describe("history", () => {
  const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
    id: 1, taskId: "t", projectKey: "k", at: 1, actor: { kind: "user", label: "You" }, via: "ppm", unattended: false,
    kind: "snoozed", changes: [], reason: null, undoOf: null, undoneBy: null, ...over,
  });
  it("says who snoozed it until when, who unsnoozed it, and that PPM brought it back", () => {
    expect(entryText(entry({ changes: [{ field: "snoozedUntil", before: null, after: "2026-11-20" }] }), {})).toBe("snoozed it until Fri 20 Nov");
    expect(entryText(entry({ changes: [{ field: "snoozeUntilChange", before: false, after: true }] }), {})).toBe("snoozed it until a link changes");
    expect(entryText(entry({ changes: [{ field: "snoozedUntil", before: "2026-11-20", after: null }] }), {})).toBe("unsnoozed it");
    expect(entryText(entry({ kind: "resurfaced", actor: { kind: "ppm", label: "PPM" } }), {})).toBe("brought it back from its snooze");
  });
});

describe("components", () => {
  it("the options write the picked choice, and Pick a date asks for a day after today first", async () => {
    const picks: unknown[] = [];
    view = await mount(<TaskSnoozeOptions task={taskDto()} today={TODAY} onPick={(p) => picks.push(p)} />);
    await click(document.querySelector('[data-snooze-choice="tomorrow"]'));
    expect(picks).toEqual([{ snoozedUntil: "2026-11-18", snoozeUntilChange: false }]);
    expect((document.querySelector('[data-snooze-choice="link"]') as HTMLButtonElement).disabled).toBe(true);
    await click(document.querySelector('[data-snooze-choice="date"]'));
    const input = document.querySelector<HTMLInputElement>('[data-snooze-date-form] input[type="date"]')!;
    expect(input.value).toBe("2026-11-20");
    expect(input.min).toBe("2026-11-18");
    await act(async () => {
      input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(picks.at(-1)).toEqual({ snoozedUntil: "2026-11-20", snoozeUntilChange: false });
    const save = document.querySelector("[data-snooze-date-save]")!;
    expect(save.className).toContain("h-7");
    expect(save.className).toContain("max-md:h-[26px]");
  });

  it("the Snoozed section is folded, opens with its count, and each row can be unsnoozed", async () => {
    useTaskViewStore.getState().setSnoozedOpen(false);
    const tasks = [snoozedTask({ title: "A" }), snoozedTask({ title: "B" })];
    const unsnoozed: string[] = [];
    view = await mount(
      <TaskSnoozedSection tasks={tasks} row={(t) => (
        <div data-row={t.title}><TaskSnoozeBadge task={t} /><UnsnoozeButton onClick={() => unsnoozed.push(t.title)} /></div>
      )} />,
    );
    const toggle = document.querySelector<HTMLButtonElement>("[data-task-snoozed-toggle]")!;
    expect(toggle.textContent).toContain("Snoozed");
    expect(toggle.textContent).toContain("2");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-row]")).toBeNull();
    expect(toggle.className).toContain(TEXT_CONTROL_HEIGHT);
    await click(toggle);
    expect([...document.querySelectorAll("[data-row]")].map((r) => r.getAttribute("data-row"))).toEqual(["A", "B"]);
    expect(document.querySelector('[data-task-snooze="snoozed"]')!.textContent).toContain("Until");
    const unsnooze = document.querySelectorAll<HTMLButtonElement>("[data-task-unsnooze]")[1]!;
    expect(unsnooze.className).toContain(TEXT_CONTROL_HEIGHT);
    await click(unsnooze);
    expect(unsnoozed).toEqual(["B"]);
    expect(useTaskViewStore.getState().snoozedOpen).toBe(true);
    useTaskViewStore.getState().setSnoozedOpen(false);
  });

  it("an empty Snoozed section draws nothing", async () => {
    view = await mount(<TaskSnoozedSection tasks={[]} row={() => null} />);
    expect(document.querySelector("[data-task-snoozed-section]")).toBeNull();
  });

  it("the phone row sheet opens the choices in place and writes one", async () => {
    const calls: unknown[] = [];
    const task = taskDto({ project: "alpha" });
    view = await mount(
      <TaskRowActionSheet task={task} statuses={[]} neighbours={{ up: null, down: null }} hasManager={false}
        onClose={() => calls.push("close")} onStatus={() => {}} onUrgency={() => {}} onReorder={() => {}} onAskManager={() => {}}
        onSnooze={(_t, patch) => calls.push(patch)} />,
    );
    const item = [...document.querySelectorAll<HTMLButtonElement>("[data-task-action-sheet] button")].find((b) => b.textContent?.includes("Snooze until"))!;
    expect(item).toBeTruthy();
    expect(document.querySelector("[data-task-action-snooze]")).toBeNull();
    await click(item);
    await click(document.querySelector('[data-task-action-snooze] [data-snooze-choice="week"]'));
    expect(calls[0]).toBe("close");
    expect(calls[1]).toMatchObject({ snoozeUntilChange: false });
  });

  it("a closed task has no Snooze in the phone sheet", async () => {
    view = await mount(
      <TaskRowActionSheet task={taskDto({ baseGroup: "closed", closedAs: "done" })} statuses={[]} neighbours={{ up: null, down: null }} hasManager={false}
        onClose={() => {}} onStatus={() => {}} onUrgency={() => {}} onReorder={() => {}} onAskManager={() => {}} onSnooze={() => {}} />,
    );
    expect([...document.querySelectorAll("[data-task-action-sheet] button")].some((b) => b.textContent?.includes("Snooze"))).toBe(false);
  });
});

describe("beside the wait", () => {
  const waitingAndBack = () => taskDto({
    baseGroup: "waiting", statusName: "Waiting", waitingOnMemberId: "me", dueDate: "2026-11-20", resurfacedToday: true,
  });
  const order = () => {
    const wait = document.querySelector("[data-task-waiting]");
    const snooze = document.querySelector("[data-task-snooze]");
    expect(wait).not.toBeNull();
    expect(snooze).not.toBeNull();
    // The snooze label follows the wait in the same meta line, never inside it.
    expect(wait!.parentElement).toBe(snooze!.parentElement);
    expect(wait!.compareDocumentPosition(snooze!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(wait!.contains(snooze!)).toBe(false);
    return snooze!;
  };

  it("on a phone row, Back today sits right after the waiting label", async () => {
    const { TaskRowMobile } = await import("../../../../src/web/components/ppm-tasks/mobile/task-row-mobile");
    view = await mount(
      <TaskRowMobile task={waitingAndBack()} depth={0} selected={false} showProject={false}
        onOpen={() => {}} onActions={() => {}} onOpenChat={() => {}} onStartChat={() => {}} />,
    );
    const snooze = order();
    expect(snooze.textContent).toContain("Back today");
    expect(snooze.className).toContain("min-w-0");
  });

  it("a snoozed phone row says on whom and the day only, and leaves its chat chip to the task page", async () => {
    const { TaskRowMobile } = await import("../../../../src/web/components/ppm-tasks/mobile/task-row-mobile");
    const task = snoozedTask({ baseGroup: "waiting", statusName: "Waiting", waitingOnMemberId: "me", snoozedUntil: "2026-11-25",
      workingSession: { kind: "manager", sessionId: "m", title: "Manager" } as never });
    view = await mount(
      <TaskRowMobile task={task} depth={0} selected={false} showProject={false}
        onOpen={() => {}} onActions={() => {}} onOpenChat={() => {}} onStartChat={() => {}} onUnsnooze={() => {}} />,
    );
    const snooze = order();
    expect(document.querySelector("[data-task-waiting-words]")!.textContent).toBe("you");
    expect(snooze.textContent).toBe("Wed 25 Nov");
    expect(snooze.getAttribute("title")).toBe("Until Wed 25 Nov");
    expect(document.querySelector("[data-session-tone]")).toBeNull();
    expect(document.querySelector("[data-task-unsnooze]")).not.toBeNull();
  });

  it("on a desktop row, a snoozed task's date sits after the wait and its date", async () => {
    const { TaskListRow } = await import("../../../../src/web/components/ppm-tasks/task-list-row");
    view = await mount(
      <TaskListRow task={snoozedTask({ baseGroup: "waiting", statusName: "Waiting", waitingOnMemberId: "me", dueDate: "2026-11-25" })} depth={0} selected={false}
        showProject={false} onSelect={() => {}} onOpenChat={() => {}} onStartChat={() => {}} onSnooze={() => {}} />,
    );
    const snooze = order();
    expect(snooze.textContent).toContain("Until");
    const when = document.querySelector("[data-task-waiting-when]");
    if (when) expect(when.compareDocumentPosition(snooze) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
