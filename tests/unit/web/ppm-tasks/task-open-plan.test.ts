/**
 * Where opening a task shows it: a sheet on a phone, the task's own window or tab when it is
 * already on screen, the preview window for a plain selection, a new window otherwise, and a tab
 * once no window can open. Plus where a new task window lands.
 */
import { describe, expect, it } from "bun:test";
import { planTaskOpen, type TaskOpenState } from "../../../../src/web/lib/ppm-tasks/task-open-plan.ts";
import { taskTabId } from "../../../../src/web/lib/ppm-tasks/task-tab-preview.ts";
import { taskWindowSpawnRect } from "../../../../src/web/lib/ppm-tasks/task-open-plan.ts";

const tab = (taskId: string, preview: boolean) => ({ id: taskTabId(taskId), type: "task" as const, metadata: { taskId, ...(preview ? { preview: true } : {}) } });
const chat = { id: "chat:claude/1", type: "chat" as const, metadata: { sessionId: "1" } };
const isWindowPanel = (id: string) => id.startsWith("__win__:");

function state(onScreen: TaskOpenState["onScreen"], over: Partial<TaskOpenState> = {}): TaskOpenState {
  return { mobile: false, onScreen, isWindowPanel, windowCount: onScreen.filter((p) => isWindowPanel(p.id)).length, maxWindows: 8, ...over };
}

describe("planTaskOpen", () => {
  it("shows a sheet on a phone, whatever is open", () => {
    expect(planTaskOpen(state([{ id: "g", tabs: [tab("a", false)] }], { mobile: true }), "a", false)).toEqual({ kind: "sheet" });
  });

  it("opens a new window when nothing shows the task", () => {
    expect(planTaskOpen(state([{ id: "g", tabs: [chat] }]), "a", false)).toEqual({ kind: "new-window" });
  });

  it("brings an open task window forward instead of opening another", () => {
    const s = state([{ id: "g", tabs: [chat] }, { id: "__win__:w1", tabs: [tab("a", false)] }]);
    expect(planTaskOpen(s, "a", false)).toEqual({ kind: "focus" });
    expect(planTaskOpen(s, "a", true)).toEqual({ kind: "focus" });
  });

  it("focuses a task the user turned into a tab, rather than opening a window for it", () => {
    expect(planTaskOpen(state([{ id: "g", tabs: [chat, tab("a", false)] }]), "a", false)).toEqual({ kind: "focus" });
  });

  it("reuses the window that shows a preview for a plain selection", () => {
    const s = state([{ id: "g", tabs: [chat] }, { id: "__win__:w1", tabs: [tab("a", true)] }]);
    expect(planTaskOpen(s, "b", false)).toEqual({ kind: "reuse-window", panelId: "__win__:w1" });
  });

  it("opens a window of its own for a kept open, even beside a preview window", () => {
    const s = state([{ id: "g", tabs: [chat] }, { id: "__win__:w1", tabs: [tab("a", true)] }]);
    expect(planTaskOpen(s, "b", true)).toEqual({ kind: "new-window" });
  });

  it("does not reuse a window whose task was kept", () => {
    const s = state([{ id: "g", tabs: [chat] }, { id: "__win__:w1", tabs: [tab("a", false)] }]);
    expect(planTaskOpen(s, "b", false)).toEqual({ kind: "new-window" });
  });

  it("never reuses a preview tab in the grid as if it were a window", () => {
    expect(planTaskOpen(state([{ id: "g", tabs: [tab("a", true)] }]), "b", false)).toEqual({ kind: "new-window" });
  });

  it("falls back to a tab at the window cap", () => {
    expect(planTaskOpen(state([{ id: "g", tabs: [chat] }], { windowCount: 8 }), "a", false)).toEqual({ kind: "tab" });
  });
});

describe("taskWindowSpawnRect", () => {
  const bounds = { w: 1440, h: 860 };

  it("opens on the right by default, wide enough for the page's two columns", () => {
    expect(taskWindowSpawnRect(bounds, [], null)).toEqual({ x: 1440 - 28 - 880, y: 16, w: 880, h: 720 });
  });

  it("fits a narrow screen", () => {
    const r = taskWindowSpawnRect({ w: 800, h: 600 }, [], null);
    expect(r.w).toBeLessThanOrEqual(800 - 32);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(800);
  });

  it("comes back where the last task window was put", () => {
    expect(taskWindowSpawnRect(bounds, [], { x: 40, y: 50, w: 700, h: 600 })).toEqual({ x: 40, y: 50, w: 700, h: 600 });
  });

  it("steps off the front task window when one is open", () => {
    const r = taskWindowSpawnRect(bounds, [{ x: 10, y: 10, w: 500, h: 500 }, { x: 100, y: 100, w: 600, h: 500 }], { x: 0, y: 0, w: 300, h: 300 });
    expect(r).toEqual({ x: 128, y: 128, w: 600, h: 500 });
  });
});
