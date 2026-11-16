/**
 * Task tabs open as a preview that the next selection replaces in place, and an edit or a
 * double-click keeps them; a task already open anywhere on screen is focused, never duplicated.
 */
import { describe, expect, it } from "bun:test";
import {
  isPreviewTab, keptMetadata, planTaskTabOpen, replaceTabInPlace, taskIdOfTab, taskTabId,
} from "../../../../src/web/lib/ppm-tasks/task-tab-preview.ts";

const tab = (taskId: string, preview: boolean) => ({ id: taskTabId(taskId), type: "task" as const, metadata: { taskId, ...(preview ? { preview: true } : {}) } });
const chat = { id: "chat:claude/1", type: "chat" as const, metadata: { sessionId: "1" } };

describe("planTaskTabOpen", () => {
  it("replaces the panel's preview when a plain selection opens another task", () => {
    const panels = [{ id: "p1", tabs: [chat, tab("a", true)] }];
    expect(planTaskTabOpen(panels, "p1", "b", false)).toEqual({ kind: "replace", panelId: "p1", tabId: "task:a" });
  });

  it("adds a new tab beside a kept one", () => {
    const panels = [{ id: "p1", tabs: [tab("a", false)] }];
    expect(planTaskTabOpen(panels, "p1", "b", false)).toEqual({ kind: "add", panelId: "p1" });
  });

  it("adds rather than replaces when the open keeps the tab (an edit or a double-click)", () => {
    const panels = [{ id: "p1", tabs: [tab("a", true)] }];
    expect(planTaskTabOpen(panels, "p1", "b", true)).toEqual({ kind: "add", panelId: "p1" });
  });

  it("focuses a task already open in another panel, and keeps it only when asked and only if it was a preview", () => {
    const panels = [{ id: "p1", tabs: [] }, { id: "p2", tabs: [tab("a", true)] }];
    expect(planTaskTabOpen(panels, "p1", "a", false)).toEqual({ kind: "focus", panelId: "p2", tabId: "task:a", keep: false });
    expect(planTaskTabOpen(panels, "p1", "a", true)).toEqual({ kind: "focus", panelId: "p2", tabId: "task:a", keep: true });
    const kept = [{ id: "p1", tabs: [tab("a", false)] }];
    expect(planTaskTabOpen(kept, "p1", "a", true)).toEqual({ kind: "focus", panelId: "p1", tabId: "task:a", keep: false });
  });

  it("only the target panel's preview is replaced", () => {
    const panels = [{ id: "p1", tabs: [] }, { id: "p2", tabs: [tab("a", true)] }];
    expect(planTaskTabOpen(panels, "p1", "b", false)).toEqual({ kind: "add", panelId: "p1" });
  });
});

describe("helpers", () => {
  it("swaps a tab in its own slot", () => {
    const next = { id: "task:z" };
    expect(replaceTabInPlace([{ id: "x" }, { id: "task:a" }, { id: "y" }], "task:a", next).map((t) => t.id)).toEqual(["x", "task:z", "y"]);
  });

  it("keeping drops only the preview mark", () => {
    expect(keptMetadata({ taskId: "a", preview: true, projectName: "p" })).toEqual({ taskId: "a", projectName: "p" });
  });

  it("reads the task of a task tab only", () => {
    expect(taskIdOfTab(tab("a", true))).toBe("a");
    expect(taskIdOfTab(chat)).toBeNull();
    expect(isPreviewTab(tab("a", true))).toBe(true);
    expect(isPreviewTab(tab("a", false))).toBe(false);
  });
});
