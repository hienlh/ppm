/**
 * Tests for reconcileTabHostWindows — repairing a half-restored workspace.
 *
 * Window geometry and panels persist to different keys, so a reload can bring back a
 * panel with no window (its tabs would be invisible and unreachable) or a window with no
 * panel (an empty frame). Mobile is the extreme case: no window is ever live there, so
 * every detached tab must come home to the grid.
 */
import { describe, it, expect } from "bun:test";
import { reconcileTabHostWindows } from "../../../src/web/stores/window-panel-reconcile";
import { DOCK_PANEL_ID, windowPanelId } from "../../../src/web/stores/panel-utils";
import type { Panel } from "../../../src/web/stores/panel-utils";

const WIN_A = windowPanelId("win-a");

function makePanel(id: string, tabIds: string[], activeTabId?: string | null): Panel {
  return {
    id,
    tabs: tabIds.map((tid) => ({
      id: tid,
      type: "terminal" as const,
      title: tid,
      projectId: "proj1",
      closable: true,
    })),
    activeTabId: activeTabId === undefined ? (tabIds[0] ?? null) : activeTabId,
    tabHistory: [...tabIds],
  };
}

describe("reconcileTabHostWindows", () => {
  it("moves the tabs of a window-less panel back into the grid and drops the panel", () => {
    const result = reconcileTabHostWindows({
      panels: {
        "panel-A": makePanel("panel-A", ["editor:/a.ts"]),
        [WIN_A]: makePanel(WIN_A, ["terminal:1"]),
      },
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      liveWindowIds: [],
    });

    expect(result.changed).toBe(true);
    expect(result.panels[WIN_A]).toBeUndefined();
    expect(result.panels["panel-A"]?.tabs.map((t) => t.id)).toEqual(["editor:/a.ts", "terminal:1"]);
    expect(result.panels["panel-A"]?.activeTabId).toBe("editor:/a.ts");
    expect(result.windowIdsToClose).toEqual([]);
  });

  it("keeps a panel whose window is alive", () => {
    const result = reconcileTabHostWindows({
      panels: {
        "panel-A": makePanel("panel-A", ["editor:/a.ts"]),
        [WIN_A]: makePanel(WIN_A, ["terminal:1"]),
      },
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      liveWindowIds: ["win-a"],
    });

    expect(result.changed).toBe(false);
    expect(result.panels[WIN_A]?.tabs.map((t) => t.id)).toEqual(["terminal:1"]);
    expect(result.windowIdsToClose).toEqual([]);
  });

  it("reports a live tab-host window that has no panel behind it", () => {
    const result = reconcileTabHostWindows({
      panels: { "panel-A": makePanel("panel-A", ["editor:/a.ts"]) },
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      liveWindowIds: ["win-orphan"],
    });

    expect(result.windowIdsToClose).toEqual(["win-orphan"]);
    expect(result.changed).toBe(false);
  });

  it("re-docks into the focused grid panel when there are several", () => {
    const result = reconcileTabHostWindows({
      panels: {
        "panel-A": makePanel("panel-A", ["editor:/a.ts"]),
        "panel-B": makePanel("panel-B", ["editor:/b.ts"]),
        [WIN_A]: makePanel(WIN_A, ["terminal:1"]),
      },
      grid: [["panel-A", "panel-B"]],
      focusedPanelId: "panel-B",
      liveWindowIds: [],
    });

    expect(result.panels["panel-B"]?.tabs.map((t) => t.id)).toEqual(["editor:/b.ts", "terminal:1"]);
    expect(result.panels["panel-A"]?.tabs.map((t) => t.id)).toEqual(["editor:/a.ts"]);
  });

  it("never re-docks into an off-grid panel, and pulls focus back onto the grid", () => {
    const result = reconcileTabHostWindows({
      panels: {
        "panel-A": makePanel("panel-A", ["editor:/a.ts"]),
        [DOCK_PANEL_ID]: makePanel(DOCK_PANEL_ID, ["terminal:9"]),
        [WIN_A]: makePanel(WIN_A, ["terminal:1"]),
      },
      grid: [["panel-A"]],
      focusedPanelId: DOCK_PANEL_ID,
      liveWindowIds: [],
    });

    expect(result.panels["panel-A"]?.tabs.map((t) => t.id)).toEqual(["editor:/a.ts", "terminal:1"]);
    expect(result.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id)).toEqual(["terminal:9"]);
    expect(result.focusedPanelId).toBe("panel-A");
  });

  it("adopts the incoming tab as active when the receiving panel is empty", () => {
    const result = reconcileTabHostWindows({
      panels: {
        "panel-A": makePanel("panel-A", [], null),
        [WIN_A]: makePanel(WIN_A, ["terminal:1"]),
      },
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      liveWindowIds: [],
    });

    expect(result.panels["panel-A"]?.activeTabId).toBe("terminal:1");
  });

  it("leaves the panel alone when there is no grid panel to receive it", () => {
    const panels = { [WIN_A]: makePanel(WIN_A, ["terminal:1"]) };

    const result = reconcileTabHostWindows({ panels, grid: [], focusedPanelId: "", liveWindowIds: [] });

    expect(result.changed).toBe(false);
    expect(result.panels[WIN_A]?.tabs.map((t) => t.id)).toEqual(["terminal:1"]);
  });

  it("is idempotent — a second run over its own output changes nothing", () => {
    const first = reconcileTabHostWindows({
      panels: {
        "panel-A": makePanel("panel-A", ["editor:/a.ts"]),
        [WIN_A]: makePanel(WIN_A, ["terminal:1"]),
      },
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      liveWindowIds: [],
    });

    const second = reconcileTabHostWindows({
      panels: first.panels,
      grid: [["panel-A"]],
      focusedPanelId: first.focusedPanelId,
      liveWindowIds: [],
    });

    expect(second.changed).toBe(false);
    expect(second.panels).toEqual(first.panels);
    expect(second.windowIdsToClose).toEqual([]);
  });
});
