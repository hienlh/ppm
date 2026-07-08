/**
 * Tests for dock⇄grid move semantics and location-based re-dock on terminal close.
 *
 * Decision rule (location-based, no Tab.home flag):
 *  - terminal closed from a GRID panel → re-dock (move to __dock__, show dock)
 *  - terminal closed from __dock__      → real close (strip localStorage key, remove tab)
 *  - non-terminal closed from anywhere  → real close
 *
 * "Re-dock" = parking the tab in __dock__ instead of killing it.
 * Real kill paths: close from dock, shell exit (onExit), idle/grace.
 */
import { describe, it, expect, beforeEach, spyOn } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal in-memory localStorage stub — must be set before store import
// ---------------------------------------------------------------------------
const memStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (key: string) => memStore[key] ?? null,
  setItem: (key: string, value: string) => { memStore[key] = value; },
  removeItem: (key: string) => { delete memStore[key]; },
  clear: () => { for (const k of Object.keys(memStore)) delete memStore[k]; },
};
(globalThis as unknown as { localStorage: typeof localStorageStub }).localStorage = localStorageStub;

// Import AFTER stubbing localStorage
import { usePanelStore } from "../../../src/web/stores/panel-store";
import { DOCK_PANEL_ID } from "../../../src/web/stores/panel-utils";
import type { Panel } from "../../../src/web/stores/panel-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePanel(id: string, tabSpecs: { id: string; type: string }[]): Panel {
  return {
    id,
    tabs: tabSpecs.map((t) => ({
      id: t.id,
      type: t.type as Panel["tabs"][number]["type"],
      title: t.id,
      projectId: "proj1",
      closable: true,
    })),
    activeTabId: tabSpecs[0]?.id ?? null,
    tabHistory: tabSpecs.map((t) => t.id),
  };
}

function makeDockPanel(tabSpecs: { id: string; type: string }[]): Panel {
  return makePanel(DOCK_PANEL_ID, tabSpecs);
}

/** Seed the store with a grid panel plus a __dock__ panel. */
function seedStore(options: {
  gridPanels: Panel[];
  grid: string[][];
  focusedPanelId: string;
  dockTabs?: { id: string; type: string }[];
  dockVisible?: boolean;
}) {
  const panelMap: Record<string, Panel> = {};
  for (const p of options.gridPanels) panelMap[p.id] = p;
  // Always include __dock__
  panelMap[DOCK_PANEL_ID] = makeDockPanel(options.dockTabs ?? []);

  usePanelStore.setState({
    panels: panelMap,
    grid: options.grid,
    focusedPanelId: options.focusedPanelId,
    currentProject: "proj1",
    projectGrids: {},
    projectFocused: {},
    dock: { visible: options.dockVisible ?? false, height: 30 },
    projectDock: {},
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("moveTab — dock⇄grid", () => {
  beforeEach(() => { localStorageStub.clear(); });

  it("moves terminal from __dock__ to grid panel — tab now in gridPanel, dock still exists", () => {
    // Set up: terminal:1 is in __dock__, grid has panel-A
    const gridPanel = makePanel("panel-A", [{ id: "editor:/foo.ts", type: "editor" }]);
    seedStore({
      gridPanels: [gridPanel],
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      dockTabs: [{ id: "terminal:1", type: "terminal" }],
      dockVisible: true,
    });

    usePanelStore.getState().moveTab("terminal:1", DOCK_PANEL_ID, "panel-A");

    const state = usePanelStore.getState();
    // Tab is now in panel-A
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).toContain("terminal:1");
    // Tab is gone from __dock__
    expect(state.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id)).not.toContain("terminal:1");
    // __dock__ panel still exists (not auto-removed by grid logic)
    expect(state.panels[DOCK_PANEL_ID]).toBeDefined();
    // Grid count unchanged — __dock__ was never in grid, source-empty auto-close should NOT affect grid
    expect(state.grid.flat()).toContain("panel-A");
    expect(state.grid.flat()).not.toContain(DOCK_PANEL_ID);
  });

  it("moves terminal from grid to __dock__ — tab in dock, source panel preserved when not empty", () => {
    const gridPanel = makePanel("panel-A", [
      { id: "terminal:1", type: "terminal" },
      { id: "editor:/foo.ts", type: "editor" },
    ]);
    seedStore({
      gridPanels: [gridPanel],
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      dockTabs: [],
    });

    usePanelStore.getState().moveTab("terminal:1", "panel-A", DOCK_PANEL_ID);

    const state = usePanelStore.getState();
    expect(state.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id)).toContain("terminal:1");
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).not.toContain("terminal:1");
    // panel-A still in grid (it still has editor tab)
    expect(state.grid.flat()).toContain("panel-A");
  });

  it("dock→grid move: session localStorage key is NOT touched (no PTY restart)", () => {
    const gridPanel = makePanel("panel-A", [{ id: "editor:/foo.ts", type: "editor" }]);
    seedStore({
      gridPanels: [gridPanel],
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      dockTabs: [{ id: "terminal:1", type: "terminal" }],
    });
    localStorageStub.setItem("ppm:terminal-session:terminal:1", "session-abc");

    const removeSpy = spyOn(localStorageStub, "removeItem");
    try {
      usePanelStore.getState().moveTab("terminal:1", DOCK_PANEL_ID, "panel-A");
      // moveTab MUST NOT strip the session key — tab reparents without restarting PTY
      const strippedSession = removeSpy.mock.calls.some(
        (args) => String(args[0]) === "ppm:terminal-session:terminal:1",
      );
      expect(strippedSession).toBe(false);
      // Session key still present in storage
      expect(localStorageStub.getItem("ppm:terminal-session:terminal:1")).toBe("session-abc");
    } finally {
      removeSpy.mockRestore();
    }
  });

  it("moveTab with __dock__ as source: does NOT call gridRemovePanel for __dock__ (defensive guard)", () => {
    // __dock__ is not in grid — auto-close guard must never attempt to remove it from grid.
    // After moving terminal:1 from __dock__ to panel-A, panel-A must still be in grid.
    const gridPanel = makePanel("panel-A", [{ id: "editor:/foo.ts", type: "editor" }]);
    seedStore({
      gridPanels: [gridPanel],
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      dockTabs: [{ id: "terminal:1", type: "terminal" }], // only one tab in dock
    });

    // Move the ONLY tab out of dock — the dock's auto-empty-close guard must NOT remove it from grid
    usePanelStore.getState().moveTab("terminal:1", DOCK_PANEL_ID, "panel-A");

    const state = usePanelStore.getState();
    // panel-A still in grid
    expect(state.grid.flat()).toContain("panel-A");
    // __dock__ still in panels (not deleted)
    expect(state.panels[DOCK_PANEL_ID]).toBeDefined();
    // grid does not contain __dock__
    expect(state.grid.flat()).not.toContain(DOCK_PANEL_ID);
  });
});

describe("closeTab — location-based re-dock semantics", () => {
  beforeEach(() => { localStorageStub.clear(); });

  it("closing terminal from GRID panel → re-docks: tab in __dock__, dock.visible===true, NO localStorage.removeItem", () => {
    const panel = makePanel("panel-A", [
      { id: "terminal:1", type: "terminal" },
      { id: "editor:/foo.ts", type: "editor" },
    ]);
    seedStore({
      gridPanels: [panel],
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      dockTabs: [],
      dockVisible: false,
    });
    localStorageStub.setItem("ppm:terminal-session:terminal:1", "session-abc");

    const removeSpy = spyOn(localStorageStub, "removeItem");
    try {
      usePanelStore.getState().closeTab("terminal:1", "panel-A");

      const state = usePanelStore.getState();
      // Tab moved to __dock__
      expect(state.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id)).toContain("terminal:1");
      // Tab removed from grid panel
      expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).not.toContain("terminal:1");
      // Dock is now visible
      expect(state.dock.visible).toBe(true);
      // Session key NOT stripped (session stays alive in dock)
      const strippedSession = removeSpy.mock.calls.some(
        (args) => String(args[0]) === "ppm:terminal-session:terminal:1",
      );
      expect(strippedSession).toBe(false);
    } finally {
      removeSpy.mockRestore();
    }
  });

  it("closing terminal from __dock__ → real close: localStorage.removeItem called, tab gone from dock", () => {
    seedStore({
      gridPanels: [makePanel("panel-A", [{ id: "editor:/foo.ts", type: "editor" }])],
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      dockTabs: [{ id: "terminal:1", type: "terminal" }],
      dockVisible: true,
    });
    localStorageStub.setItem("ppm:terminal-session:terminal:1", "session-abc");

    const removeSpy = spyOn(localStorageStub, "removeItem");
    try {
      usePanelStore.getState().closeTab("terminal:1", DOCK_PANEL_ID);

      const state = usePanelStore.getState();
      // Tab removed from dock
      expect(state.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id)).not.toContain("terminal:1");
      // localStorage key stripped (real close)
      expect(removeSpy).toHaveBeenCalledWith("ppm:terminal-session:terminal:1");
    } finally {
      removeSpy.mockRestore();
    }
  });

  it("closing non-terminal tab from grid → real close (no re-dock)", () => {
    const panel = makePanel("panel-A", [
      { id: "editor:/bar.ts", type: "editor" },
      { id: "terminal:2", type: "terminal" },
    ]);
    seedStore({
      gridPanels: [panel],
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      dockTabs: [],
      dockVisible: false,
    });

    usePanelStore.getState().closeTab("editor:/bar.ts", "panel-A");

    const state = usePanelStore.getState();
    // Editor tab removed from panel (real close)
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).not.toContain("editor:/bar.ts");
    // Dock NOT shown (no re-dock triggered)
    expect(state.dock.visible).toBe(false);
    // Dock has no editor tab (only terminals can re-dock)
    expect(state.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id)).not.toContain("editor:/bar.ts");
  });

  it("loop guard: closeTab(terminal, gridPanel) performs a single state transition, redockTab never calls closeTab again", () => {
    const panel = makePanel("panel-A", [{ id: "terminal:3", type: "terminal" }]);
    seedStore({
      gridPanels: [panel],
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      dockTabs: [],
    });

    // Track how many times closeTab is entered by the store's implementation.
    // We spy on the original function; if the re-dock path re-called closeTab,
    // the spy count would be > 1. After the first call resolves, tab must be in __dock__.
    let callCount = 0;
    const original = usePanelStore.getState().closeTab;
    usePanelStore.setState({
      closeTab: (tabId, panelId?) => {
        callCount++;
        original(tabId, panelId);
      },
    });

    usePanelStore.getState().closeTab("terminal:3", "panel-A");

    // Our wrapper was called exactly once (no recursive re-entry from redockTab)
    expect(callCount).toBe(1);

    const state = usePanelStore.getState();
    // Terminal is in dock (re-dock happened)
    expect(state.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id)).toContain("terminal:3");

    // Restore original
    usePanelStore.setState({ closeTab: original });
  });

  it("closing terminal from grid when __dock__ already has tabs: terminal appended, dock visible", () => {
    const panel = makePanel("panel-A", [
      { id: "terminal:4", type: "terminal" },
    ]);
    seedStore({
      gridPanels: [panel],
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      dockTabs: [{ id: "terminal:5", type: "terminal" }],
      dockVisible: false,
    });

    usePanelStore.getState().closeTab("terminal:4", "panel-A");

    const state = usePanelStore.getState();
    const dockTabIds = state.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id) ?? [];
    expect(dockTabIds).toContain("terminal:4");
    expect(dockTabIds).toContain("terminal:5");
    expect(state.dock.visible).toBe(true);
  });
});
