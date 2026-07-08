/**
 * Tests for dock-panel tab collection in collectTabEntries / collectFromDock.
 *
 * Locks the contract added in phase 03: panels["__dock__"] tabs are included in
 * the TabPool keep-alive pool, deduped against grid tabs (grid wins), and collected
 * for ALL projects so terminals stay alive across project switches.
 */
import { describe, it, expect } from "bun:test";
import { collectTabEntries } from "../../../src/web/components/layout/tab-pool-collect";
import { DOCK_PANEL_ID } from "../../../src/web/stores/panel-utils";
import type { Panel } from "../../../src/web/stores/panel-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Dock collection basics
// ---------------------------------------------------------------------------

describe("collectTabEntries — dock collection", () => {
  it("collects a terminal tab from the __dock__ panel", () => {
    const dockPanel = makePanel(DOCK_PANEL_ID, [{ id: "terminal:9", type: "terminal", projectId: "proj-1" }]);
    const gridPanel = makePanel("panel-A", [{ id: "editor:/foo.ts", type: "editor", projectId: "proj-1" }]);
    const panels: Record<string, Panel> = {
      "panel-A": gridPanel,
      [DOCK_PANEL_ID]: dockPanel,
    };

    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-1");

    const dockEntry = entries.find((e) => e.tabId === "terminal:9");
    expect(dockEntry).toBeDefined();
    expect(dockEntry?.panelId).toBe(DOCK_PANEL_ID);
    expect(dockEntry?.type).toBe("terminal");
  });

  it("sets isActive=true when the dock tab matches dockPanel.activeTabId", () => {
    const dockPanel = makePanel(
      DOCK_PANEL_ID,
      [
        { id: "terminal:9", type: "terminal", projectId: "proj-1" },
        { id: "terminal:10", type: "terminal", projectId: "proj-1" },
      ],
      "terminal:10", // second tab is active
    );
    const panels: Record<string, Panel> = { [DOCK_PANEL_ID]: dockPanel };

    const entries = collectTabEntries(panels, [], {}, "proj-1");

    const entry9 = entries.find((e) => e.tabId === "terminal:9");
    const entry10 = entries.find((e) => e.tabId === "terminal:10");
    expect(entry9?.isActive).toBe(false);
    expect(entry10?.isActive).toBe(true);
  });

  it("produces exactly one entry per dock tab (no duplication)", () => {
    const dockPanel = makePanel(DOCK_PANEL_ID, [{ id: "terminal:9", type: "terminal", projectId: "proj-1" }]);
    const panels: Record<string, Panel> = { [DOCK_PANEL_ID]: dockPanel };

    const entries = collectTabEntries(panels, [], {}, "proj-1");

    const dockEntries = entries.filter((e) => e.tabId === "terminal:9");
    expect(dockEntries).toHaveLength(1);
  });

  it("collects dock tabs even when there are no grid panels (empty grid)", () => {
    const dockPanel = makePanel(DOCK_PANEL_ID, [{ id: "terminal:9", type: "terminal" }]);
    const panels: Record<string, Panel> = { [DOCK_PANEL_ID]: dockPanel };

    const entries = collectTabEntries(panels, [], {}, null);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.tabId).toBe("terminal:9");
    expect(entries[0]?.panelId).toBe(DOCK_PANEL_ID);
  });

  // -------------------------------------------------------------------------
  // Dedup: grid precedence
  // The same tabId can briefly exist in both a grid panel and the dock panel
  // during a move operation (phase 05). Grid is collected FIRST, so when
  // seenTabs sees the id again at dock collection time, the dock entry is
  // skipped. This ensures the tab renders in the grid slot (where the user
  // just moved it), not the dock slot.
  // -------------------------------------------------------------------------
  it("deduplicates: grid wins when a tabId exists in both a grid panel and __dock__", () => {
    const gridPanel = makePanel("panel-A", [{ id: "terminal:9", type: "terminal", projectId: "proj-1" }]);
    const dockPanel = makePanel(DOCK_PANEL_ID, [{ id: "terminal:9", type: "terminal", projectId: "proj-1" }]);
    const panels: Record<string, Panel> = {
      "panel-A": gridPanel,
      [DOCK_PANEL_ID]: dockPanel,
    };

    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-1");

    // Only one entry for terminal:9 ...
    const matches = entries.filter((e) => e.tabId === "terminal:9");
    expect(matches).toHaveLength(1);

    // ... and it must be the grid entry, NOT the dock entry.
    // This is guaranteed because grid is collected before dock (seenTabs dedup).
    expect(matches[0]?.panelId).toBe("panel-A");
  });

  // -------------------------------------------------------------------------
  // Cross-project keep-alive: ALL dock tabs collected regardless of projectId.
  // The __dock__ panel is shared across projects; filtering by active project
  // happens at render time (dock slot only renders active project's active tab),
  // NOT at collection time. This mirrors how grid keep-alive collects all
  // projects' panels so their WS / xterm survive a project switch.
  // -------------------------------------------------------------------------
  it("collects dock tabs from non-active projects (keep-alive: no projectId filter at collection)", () => {
    const dockPanel = makePanel(DOCK_PANEL_ID, [
      { id: "terminal:1", type: "terminal", projectId: "proj-active" },
      { id: "terminal:2", type: "terminal", projectId: "proj-other" },
    ]);
    const gridPanel = makePanel("panel-A", [{ id: "editor:/a.ts", type: "editor", projectId: "proj-active" }]);
    const panels: Record<string, Panel> = {
      "panel-A": gridPanel,
      [DOCK_PANEL_ID]: dockPanel,
    };

    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-active");

    // Both dock terminals collected — the non-active one parks (no slot) but stays alive
    expect(entries.find((e) => e.tabId === "terminal:1")).toBeDefined();
    expect(entries.find((e) => e.tabId === "terminal:2")).toBeDefined();
  });

  it("dock entries are included in the sorted output (stable key order maintained)", () => {
    const gridPanel = makePanel("panel-A", [{ id: "editor:/z.ts", type: "editor", projectId: "proj-1" }]);
    const dockPanel = makePanel(DOCK_PANEL_ID, [{ id: "terminal:3", type: "terminal", projectId: "proj-1" }]);
    const panels: Record<string, Panel> = {
      "panel-A": gridPanel,
      [DOCK_PANEL_ID]: dockPanel,
    };

    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-1");

    const ids = entries.map((e) => e.tabId);
    expect(ids).toEqual([...ids].sort());
  });

  it("handles missing __dock__ panel gracefully (no entry, no throw)", () => {
    const gridPanel = makePanel("panel-A", [{ id: "terminal:1", type: "terminal", projectId: "proj-1" }]);
    // panels has NO __dock__ key
    const panels: Record<string, Panel> = { "panel-A": gridPanel };

    expect(() => collectTabEntries(panels, [["panel-A"]], {}, "proj-1")).not.toThrow();
    const entries = collectTabEntries(panels, [["panel-A"]], {}, "proj-1");
    expect(entries).toHaveLength(1); // only the grid entry
  });
});
