/**
 * Tests for window-panel collection in collectTabEntries / collectFromWindowPanels.
 *
 * A detached tab is in neither a grid nor the dock, so without this pass TabPool would
 * mount it nowhere and the floating window would stay empty. Mirrors the dock rules:
 * global (no project filter), collected after the grids so a grid entry wins a collision.
 */
import { describe, it, expect } from "bun:test";
import { collectTabEntries } from "../../../src/web/components/layout/tab-pool-collect";
import { DOCK_PANEL_ID, windowPanelId } from "../../../src/web/stores/panel-utils";
import type { Panel } from "../../../src/web/stores/panel-utils";

const WIN_PANEL = windowPanelId("win-1");

function makePanel(id: string, tabs: { id: string; type: string; projectId?: string }[], activeTabId?: string): Panel {
  const builtTabs = tabs.map((t) => ({
    id: t.id,
    type: t.type as Panel["tabs"][number]["type"],
    title: t.id,
    projectId: t.projectId ?? null,
    closable: true,
  }));
  return {
    id,
    tabs: builtTabs,
    activeTabId: activeTabId ?? builtTabs[0]?.id ?? null,
    tabHistory: builtTabs.map((t) => t.id),
  };
}

describe("collectTabEntries — window panels", () => {
  it("collects a tab from a __win__: panel and reports the window panel id", () => {
    const panels: Record<string, Panel> = {
      "panel-A": makePanel("panel-A", [{ id: "editor:/a.ts", type: "editor", projectId: "proj-1" }]),
      [WIN_PANEL]: makePanel(WIN_PANEL, [{ id: "terminal:9", type: "terminal", projectId: "proj-1" }]),
    };

    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-1");

    const entry = entries.find((e) => e.tabId === "terminal:9");
    expect(entry?.panelId).toBe(WIN_PANEL);
    expect(entry?.type).toBe("terminal");
    expect(entry?.isActive).toBe(true);
  });

  it("marks only the window panel's active tab as active", () => {
    const panels: Record<string, Panel> = {
      [WIN_PANEL]: makePanel(
        WIN_PANEL,
        [
          { id: "terminal:9", type: "terminal", projectId: "proj-1" },
          { id: "terminal:10", type: "terminal", projectId: "proj-1" },
        ],
        "terminal:10",
      ),
    };

    const entries = collectTabEntries(panels, [], {}, "proj-1");

    expect(entries.find((e) => e.tabId === "terminal:9")?.isActive).toBe(false);
    expect(entries.find((e) => e.tabId === "terminal:10")?.isActive).toBe(true);
  });

  it("collects a detached tab from a non-active project (a floating window survives a switch)", () => {
    const panels: Record<string, Panel> = {
      "panel-A": makePanel("panel-A", [{ id: "editor:/a.ts", type: "editor", projectId: "proj-active" }]),
      [WIN_PANEL]: makePanel(WIN_PANEL, [{ id: "terminal:9", type: "terminal", projectId: "proj-other" }]),
    };

    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-active");

    expect(entries.find((e) => e.tabId === "terminal:9")).toBeDefined();
  });

  it("deduplicates: the grid wins when a tabId is in both a grid panel and a window panel", () => {
    const panels: Record<string, Panel> = {
      "panel-A": makePanel("panel-A", [{ id: "terminal:9", type: "terminal", projectId: "proj-1" }]),
      [WIN_PANEL]: makePanel(WIN_PANEL, [{ id: "terminal:9", type: "terminal", projectId: "proj-1" }]),
    };

    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-1");

    const matches = entries.filter((e) => e.tabId === "terminal:9");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.panelId).toBe("panel-A");
  });

  it("deduplicates: the window panel wins over the dock (dock is collected last)", () => {
    const panels: Record<string, Panel> = {
      [WIN_PANEL]: makePanel(WIN_PANEL, [{ id: "terminal:9", type: "terminal", projectId: "proj-1" }]),
      [DOCK_PANEL_ID]: makePanel(DOCK_PANEL_ID, [{ id: "terminal:9", type: "terminal", projectId: "proj-1" }]),
    };

    const entries = collectTabEntries(panels, [], {}, "proj-1");

    const matches = entries.filter((e) => e.tabId === "terminal:9");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.panelId).toBe(WIN_PANEL);
  });

  it("collects grid, window and dock tabs together in stable key order", () => {
    const panels: Record<string, Panel> = {
      "panel-A": makePanel("panel-A", [{ id: "editor:/z.ts", type: "editor", projectId: "proj-1" }]),
      [WIN_PANEL]: makePanel(WIN_PANEL, [{ id: "chat:p/1", type: "chat", projectId: "proj-1" }]),
      [DOCK_PANEL_ID]: makePanel(DOCK_PANEL_ID, [{ id: "terminal:3", type: "terminal", projectId: "proj-1" }]),
    };

    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-1");

    expect(entries).toHaveLength(3);
    const ids = entries.map((e) => e.tabId);
    expect(ids).toEqual([...ids].sort());
  });

  it("produces nothing extra when there is no window panel", () => {
    const panels: Record<string, Panel> = {
      "panel-A": makePanel("panel-A", [{ id: "terminal:1", type: "terminal", projectId: "proj-1" }]),
    };

    expect(collectTabEntries(panels, [["panel-A"]], {}, "proj-1")).toHaveLength(1);
  });
});
