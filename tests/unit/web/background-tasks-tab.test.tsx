/**
 * The CLI's background tasks: what a `background_tasks_changed` payload turns into, and the footer
 * chip's Tasks tab that lists them, each with a Stop.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { liveTasksFrom, taskKindLabel } from "../../../src/shared/background-tasks";
import { clearBackgroundTasks, type BackgroundTaskState } from "../../../src/server/ws/chat-background-tasks";

describe("liveTasksFrom", () => {
  it("keeps well-formed tasks and drops ambient ones and junk", () => {
    expect(liveTasksFrom([
      { task_id: "b1", task_type: "local_bash", description: "Run sleep 300" },
      { task_id: "a1", task_type: "local_agent", description: "Review", subagent_type: "reviewer", parent_task_id: "a0" },
      { task_id: "w1", task_type: "monitor", description: "watch", ambient: true },
      { task_type: "local_bash" },
      null,
      "x",
    ])).toEqual([
      { taskId: "b1", taskType: "local_bash", description: "Run sleep 300" },
      { taskId: "a1", taskType: "local_agent", description: "Review", subagentType: "reviewer", parentTaskId: "a0" },
    ]);
    expect(liveTasksFrom(undefined)).toEqual([]);
  });

  it("names each kind of task", () => {
    expect(taskKindLabel({ taskType: "local_bash" })).toBe("Command");
    expect(taskKindLabel({ taskType: "local_agent", subagentType: "general-purpose" })).toBe("Agent");
    expect(taskKindLabel({ taskType: "local_agent", subagentType: "reviewer" })).toBe("Agent · reviewer");
    expect(taskKindLabel({ taskType: "something_new" })).toBe("Task");
  });

  it("a subprocess teardown forgets the list, since the CLI that ran them is gone", () => {
    const state: BackgroundTaskState = { liveTasks: [{ taskId: "b1", taskType: "local_bash", description: "x" }] };
    clearBackgroundTasks(state);
    expect(state.liveTasks).toEqual([]);
  });
});

installDom();
afterAll(uninstallDom);

const { ActivityChip } = await import("../../../src/web/components/chat/activity-chip");
const { setGlobalWsClient } = await import("../../../src/web/lib/global-ws-channel");

let view: Mounted | null = null;
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  setGlobalWsClient({ isConnected: true, send: () => {} } as never);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  setGlobalWsClient(null);
});

const tasks = [
  { taskId: "b1", taskType: "local_bash", description: "Run sleep 300" },
  { taskId: "m1", taskType: "monitor", description: "Watch the build" },
];

function renderChip(props: Record<string, unknown>) {
  return mount(createElement(ActivityChip, {
    projectName: "proj", agentProviderId: "claude", sessionId: "sess-1", messages: [], teamName: "sess-1", teamMembers: [],
    ...props,
  } as never));
}

describe("ActivityChip: Tasks tab", () => {
  it("shows a chip for background tasks alone, opens on Tasks, and Stop sends that task's id once", async () => {
    const stopped: string[] = [];
    view = await renderChip({ liveTasks: tasks, onStopTask: (id: string) => stopped.push(id) });
    const chip = view.container.querySelector<HTMLButtonElement>("[data-activity-chip]")!;
    expect(chip.querySelector('[data-activity-part="tasks"]')?.textContent).toContain("2");
    expect(chip.getAttribute("data-activity-dot")).toBe("running");

    await click(chip);
    expect(view.container.querySelector('[data-activity-tab="tasks"]')?.getAttribute("aria-selected")).toBe("true");
    const rows = view.container.querySelectorAll("[data-background-task]");
    expect([...rows].map((r) => r.textContent)).toEqual(["Run sleep 300Command", "Watch the buildMonitor"]);

    const stop = view.container.querySelector<HTMLButtonElement>('[data-stop-task="b1"]')!;
    await click(stop);
    expect(stopped).toEqual(["b1"]);
    expect(stop.disabled).toBe(true);
    expect(rows[0]!.textContent).toContain("Stopping…");
    await click(stop);
    expect(stopped).toEqual(["b1"]);
  });

  it("has no chip and no Tasks tab once the list is empty", async () => {
    view = await renderChip({ liveTasks: [] });
    expect(view.container.querySelector("[data-activity-chip]")).toBeNull();
  });
});
