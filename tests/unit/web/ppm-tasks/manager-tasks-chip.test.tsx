/**
 * The manager chat's Tasks chip: shown only in a project's manager chat while that project's task
 * store is on, labelled "<n> tasks · <k> now" with a red dot while something is in Now, and named
 * "Tasks: n open, k now" for screen readers. Its list shows open top-level tasks in "what to do
 * first" order, cut with "<m> more".
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../../helpers/react-dom.tsx";
import { taskDto } from "./task-fixture.ts";
import type { TaskProjectSummary } from "../../../../src/shared/ppm-tasks-api.ts";

afterAll(uninstallDom);

const { act } = await import("react");
const { ManagerTasksChip, tasksChipLabel } = await import("../../../../src/web/components/ppm-tasks/chip/manager-tasks-chip");
const { useManagerTasksSummary, managerProjectOf } = await import("../../../../src/web/components/ppm-tasks/chip/use-manager-tasks-summary");
const { chipListView } = await import("../../../../src/web/components/ppm-tasks/chip/manager-tasks-popover-list");

const realFetch = globalThis.fetch;
let view: Mounted | null = null;
let projects: TaskProjectSummary[] = [];
let projectReads = 0;

const summary = (over: Partial<TaskProjectSummary> = {}): TaskProjectSummary =>
  ({ name: "alpha", projectKey: "k-alpha", enabled: true, hasManager: true, open: 9, now: 2, ...over });

const { refreshManagerChats } = await import("../../../../src/web/hooks/use-manager-chats");

/** One server for the manager list and the projects' counts. */
async function serve(): Promise<void> {
  installDom();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    let data: unknown = [];
    if (url.endsWith("/api/assistant/managers")) data = { managers: [{ sessionId: "m-alpha", projectName: "alpha", providerId: "claude" }] };
    if (url.endsWith("/api/tasks/projects")) { projectReads++; data = projects; }
    return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  // The manager list is shared and read once per page: read it now, from this server.
  await refreshManagerChats();
}

afterEach(async () => { await view?.unmount(); view = null; projectReads = 0; globalThis.fetch = realFetch; });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function Harness({ sessionId }: { sessionId: string | null }) {
  const s = useManagerTasksSummary(sessionId);
  return s ? <ManagerTasksChip summary={s} /> : <p data-no-chip="">none</p>;
}

const chip = () => document.querySelector<HTMLButtonElement>("[data-manager-tasks-chip]");

describe("useManagerTasksSummary", () => {
  it("names the manager chat's project, and nothing for another chat", () => {
    const managers = [{ sessionId: "m-alpha", projectName: "alpha" }];
    expect(managerProjectOf("m-alpha", managers)).toBe("alpha");
    expect(managerProjectOf("c-other", managers)).toBeNull();
    expect(managerProjectOf(null, managers)).toBeNull();
    expect(managerProjectOf("m-alpha", null)).toBeNull();
  });

  it("shows no chip outside a manager chat, and reads no counts for it", async () => {
    projects = [summary()];
    await serve();
    view = await mount(<Harness sessionId="c-other" />);
    await settle();
    expect(chip()).toBeNull();
    expect(projectReads).toBe(0);
  });

  it("shows no chip while the project's task store is off", async () => {
    projects = [summary({ enabled: false })];
    await serve();
    view = await mount(<Harness sessionId="m-alpha" />);
    await settle();
    expect(chip()).toBeNull();
  });

  it("shows the counts in a manager chat with tasks on, and re-reads them when the project's tasks change", async () => {
    projects = [summary()];
    await serve();
    view = await mount(<Harness sessionId="m-alpha" />);
    await settle();
    expect(chip()!.getAttribute("aria-label")).toBe("Tasks: 9 open, 2 now");
    projects = [summary({ open: 10, now: 0 })];
    await act(async () => { window.dispatchEvent(new CustomEvent("tasks:changed", { detail: { type: "tasks:changed", project: "beta", taskIds: [] } })); });
    await settle();
    expect(chip()!.getAttribute("aria-label")).toBe("Tasks: 9 open, 2 now");
    await act(async () => { window.dispatchEvent(new CustomEvent("tasks:changed", { detail: { type: "tasks:changed", project: "alpha", taskIds: [] } })); });
    await settle();
    expect(chip()!.getAttribute("aria-label")).toBe("Tasks: 10 open, 0 now");
  });
});

describe("ManagerTasksChip", () => {
  it("reads '<n> tasks · <k> now' with a red dot while something is in Now", async () => {
    view = await mount(<ManagerTasksChip summary={summary()} />);
    const c = chip()!;
    expect(c.textContent).toBe("9tasks· 2 now");
    expect(c.querySelector("[data-tasks-now-dot]")).not.toBeNull();
    expect(c.getAttribute("aria-haspopup")).toBe("dialog");
    expect(c.getAttribute("aria-expanded")).toBe("false");
  });

  it("has no dot and no 'now' when nothing is in Now, and says 'task' for one", async () => {
    view = await mount(<ManagerTasksChip summary={summary({ open: 1, now: 0 })} />);
    const c = chip()!;
    expect(c.textContent).toBe("1task");
    expect(c.querySelector("[data-tasks-now-dot]")).toBeNull();
    expect(tasksChipLabel(1, 0)).toBe("Tasks: 1 open, 0 now");
  });
});

describe("chipListView", () => {
  it("lists open top-level tasks by urgency, cut at the limit with the rest counted", () => {
    const parent = taskDto({ urgency: "now", importance: "must" });
    const tasks = [
      taskDto({ urgency: "later" }),
      parent,
      taskDto({ urgency: "now", parentId: parent.id }),
      taskDto({ urgency: "today" }),
      taskDto({ urgency: "now", baseGroup: "closed", closedAs: "done" }),
      taskDto({ urgency: "week" }),
    ];
    const v = chipListView(tasks, 3);
    expect(v.groups.map((g) => [g.urgency, g.tasks.length])).toEqual([["now", 1], ["today", 1], ["week", 1]]);
    expect(v.more).toBe(1);
    expect(v.ids).toHaveLength(3);
    expect(chipListView(tasks).more).toBe(0);
  });
});
