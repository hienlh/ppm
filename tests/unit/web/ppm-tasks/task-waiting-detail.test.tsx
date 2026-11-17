/**
 * A waiting task's row says on whom it waits and until when, in the Tasks sidebar (desktop and
 * phone rows) and in the manager chat's Tasks chip list, where it used to say only "Waiting"; a
 * wait on the user stands out. "Waiting on you" narrows both lists to the user's own waits.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installGlobal, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";
import { taskDto } from "./task-fixture.ts";
import type { TaskDto } from "../../../../src/shared/ppm-tasks-api.ts";
import type { TaskMember } from "../../../../src/shared/ppm-tasks.ts";

installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);

const { act } = await import("react");
const { TaskListRow } = await import("../../../../src/web/components/ppm-tasks/task-list-row");
const { TaskRowMobile } = await import("../../../../src/web/components/ppm-tasks/mobile/task-row-mobile");
const { ManagerTasksChip } = await import("../../../../src/web/components/ppm-tasks/chip/manager-tasks-chip");
const { chipListView } = await import("../../../../src/web/components/ppm-tasks/chip/manager-tasks-popover-list");
const { visibleTasks, waitingOnMeCount } = await import("../../../../src/web/lib/ppm-tasks/task-list-view");
const { taskWaiting } = await import("../../../../src/web/lib/ppm-tasks/task-format");
const { ppmTasksStore } = await import("../../../../src/web/stores/ppm-tasks-store");
const { EMPTY_FILTERS } = await import("../../../../src/web/stores/ppm-tasks-view-store");

const DAY = 86_400_000;
const realFetch = globalThis.fetch;
let view: Mounted | null = null;
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);

const members: TaskMember[] = [{ id: "m1", projectKey: "k-demo", name: "Việt", jiraAccountId: null, githubLogin: null, slackUserId: null, position: 0, archivedAt: null }];
const waiting = (over: Partial<TaskDto> = {}) => taskDto({ statusName: "Waiting", baseGroup: "waiting", ...over });

afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  ppmTasksStore.setState({ lists: {}, details: {} } as never);
});

const noop = () => {};
const desktopRow = (task: TaskDto) => mount(<TaskListRow task={task} depth={0} selected={false} showProject={false} members={members}
  onSelect={noop} onOpenChat={noop} onStartChat={noop} />);
const phoneRow = (task: TaskDto) => mount(<TaskRowMobile task={task} depth={0} selected={false} showProject={false} members={members}
  onOpen={noop} onActions={noop} onOpenChat={noop} onStartChat={noop} />);

describe("the waiting label on a row", () => {
  it("says the wait is on the user, marked and in the accent colour, with how long since it moved into Waiting", async () => {
    view = await desktopRow(waiting({ waitingOnMemberId: "me", waitingStartedAt: Date.now() - 2 * DAY }));
    const label = $("[data-task-waiting]")!;
    expect(label.getAttribute("data-task-waiting")).toBe("me");
    expect(label.textContent).toBe("Waiting on you");
    // The age is an item of its own in the sidebar's wrapping meta line, marked by a clock.
    const when = $("[data-task-waiting-when]")!;
    expect(when.textContent).toBe("2d");
    expect(when.querySelector("svg")).not.toBeNull();
    expect(label.className).toContain("text-primary");
    expect(label.querySelector("svg")).not.toBeNull();
    expect(label.getAttribute("title")).toBe("Waiting on you for 2d");
  });

  it("names a member and shows the due date instead of the age when there is one", async () => {
    view = await desktopRow(waiting({ waitingOnMemberId: "m1", waitingStartedAt: Date.now() - 3 * DAY, dueDate: "2099-01-05" }));
    const label = $("[data-task-waiting]")!;
    expect(label.getAttribute("data-task-waiting")).toBe("member");
    expect(label.getAttribute("data-task-waiting-until")).toBe("due");
    expect($("[data-task-waiting-words]")!.textContent).toBe("Waiting on Việt");
    expect($("[data-task-waiting-when] [data-due]")).not.toBeNull();
    expect(label.className).toContain("text-warning");
    // The due date is the label's: it is not drawn a second time beside it.
    expect(document.querySelectorAll("[data-due]").length).toBe(1);
  });

  it("says Waiting with how long when nobody is named, where it used to show nothing", async () => {
    view = await phoneRow(waiting({ waitingSince: null, waitingStartedAt: Date.now() - 5 * 3_600_000 }));
    expect($("[data-task-waiting]")!.getAttribute("data-task-waiting")).toBe("unknown");
    expect($("[data-task-waiting]")!.textContent).toBe("Waiting·5h");
  });

  it("keeps the date or age inside the label on a phone row, whose meta line does not wrap", async () => {
    view = await phoneRow(waiting({ waitingOnMemberId: "me", dueDate: "2099-01-05" }));
    expect($("[data-task-waiting] [data-due]")).not.toBeNull();
    expect($("[data-task-waiting-when]")).toBeNull();
  });

  it("never wraps, and short of room the date or age gives way before on whom", async () => {
    view = await phoneRow(waiting({ waitingOnMemberId: "m1", waitingStartedAt: Date.now() - DAY }));
    const label = $("[data-task-waiting]")!;
    expect(label.className).toContain("whitespace-nowrap");
    expect($("[data-task-waiting-words]")!.className).toContain("truncate");
    expect($("[data-task-waiting-inline-when]")!.className).toContain("shrink-[10]");
    expect($("[data-task-waiting-age]")!.parentElement!.className).toContain("truncate");
  });

  it("leaves a task that does not wait as it was", async () => {
    view = await desktopRow(taskDto({ dueDate: "2099-01-05" }));
    expect($("[data-task-waiting]")).toBeNull();
    expect($("[data-due]")).not.toBeNull();
  });

  it("takes the name the server sent when the view has no member list", () => {
    expect(taskWaiting(waiting({ waitingOnMemberId: "m9", waitingOnName: "Azam" }))!.label).toBe("Waiting on Azam");
    expect(taskWaiting(waiting({ waitingOnMemberId: "m1", waitingOnName: "Old name" }), members)!.label).toBe("Waiting on Việt");
  });
});

describe("the Waiting on you filter", () => {
  const mineTop = waiting({ waitingOnMemberId: "me", urgency: "today" });
  const parent = taskDto({ urgency: "now" });
  const mineChild = waiting({ waitingOnMemberId: "me", parentId: parent.id, urgency: "now" });
  const theirs = waiting({ waitingOnMemberId: "m1" });
  const activeMine = taskDto({ baseGroup: "active", waitingOnMemberId: "me" });
  const closedMine = taskDto({ baseGroup: "closed", waitingOnMemberId: "me" });
  const otherProject = waiting({ waitingOnMemberId: "me", project: "beta" });
  const all = [mineTop, parent, mineChild, theirs, activeMine, closedMine, otherProject];

  it("keeps only the open tasks waiting on the user, children included", () => {
    const shown = visibleTasks(all, { ...EMPTY_FILTERS, waitingOnMe: true }, [], "project");
    expect(shown.map((t) => t.id).sort()).toEqual([mineTop.id, mineChild.id, activeMine.id, otherProject.id].sort());
    expect(visibleTasks(all, EMPTY_FILTERS, [], "project")).toHaveLength(6);
  });

  it("counts them, leaving out hidden projects in the all-projects view", () => {
    expect(waitingOnMeCount(all, [], "project")).toBe(4);
    expect(waitingOnMeCount(all, ["beta"], "all")).toBe(3);
  });

  it("lists a child waiting on the user as a row of its own in the chip's list", () => {
    const view = chipListView([mineChild, mineTop, parent], 8, true);
    expect(view.ids).toEqual([parent.id, mineChild.id, mineTop.id]);
    expect(chipListView([mineChild, parent], 8).ids).toEqual([parent.id]);
  });
});

describe("the Tasks chip's list", () => {
  let tasks: TaskDto[] = [];
  function serve(): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://x").pathname;
      const data = path === "/api/tasks" ? { tasks, projects: [] } : path === "/api/tasks/link-states" ? { tasks: {} } : [];
      return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  }

  it("says on whom and until when instead of only 'Waiting', and filters to the user's own waits", async () => {
    const mine = waiting({ project: "alpha", waitingOnMemberId: "me", urgency: "now", dueDate: "2099-01-05" });
    const theirs = waiting({ project: "alpha", waitingOnMemberId: "m1", waitingOnName: "Việt", urgency: "today", waitingStartedAt: Date.now() - 2 * DAY });
    const plain = taskDto({ project: "alpha", statusName: "In progress", baseGroup: "active", urgency: "today" });
    tasks = [mine, theirs, plain];
    serve();
    view = await mount(<ManagerTasksChip summary={{ name: "alpha", open: 3, now: 1 }} />);
    await act(async () => { $("[data-manager-tasks-chip]")!.click(); });
    await settle();

    const rowOf = (t: TaskDto) => $(`[data-chip-task="${t.id}"]`)!;
    expect($("[data-task-waiting]", rowOf(mine))!.getAttribute("data-task-waiting")).toBe("me");
    expect($("[data-task-waiting-words]", rowOf(mine))!.textContent).toBe("Waiting on you");
    expect($("[data-due]", rowOf(mine))).not.toBeNull();
    expect($("[data-task-waiting-words]", rowOf(theirs))!.textContent).toBe("Waiting on Việt");
    expect($("[data-task-waiting-age]", rowOf(theirs))!.textContent).toBe("2d");
    expect(rowOf(plain).textContent).toContain("In progress");
    expect(rowOf(mine).textContent).not.toContain("—");

    const toggle = $<HTMLButtonElement>("[data-task-waiting-on-me-filter]")!;
    expect($("[data-task-waiting-on-me-count]", toggle)!.textContent).toBe("1");
    expect(toggle.className).toContain("h-7");
    expect(toggle.className).toContain("max-md:h-[26px]");
    await act(async () => { toggle.click(); });
    await settle();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll("[data-chip-task]").length).toBe(1);
    expect(rowOf(mine)).not.toBeNull();
  });

  it("says nothing waits on the user when the filter is on and nothing does", async () => {
    tasks = [waiting({ project: "alpha", waitingOnMemberId: "m1" })];
    serve();
    view = await mount(<ManagerTasksChip summary={{ name: "alpha", open: 1, now: 0 }} />);
    await act(async () => { $("[data-manager-tasks-chip]")!.click(); });
    await settle();
    await act(async () => { $<HTMLButtonElement>("[data-task-waiting-on-me-filter]")!.click(); });
    await settle();
    expect($("[data-manager-tasks-list]")!.textContent).toContain("Nothing is waiting on you");
  });
});
