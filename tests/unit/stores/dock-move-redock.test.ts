/**
 * Tests for dock⇄grid move semantics and terminal close semantics.
 *
 * Close always ends the terminal, wherever the tab lives:
 *  - terminal closed from a GRID panel → real close (strip localStorage key, remove tab)
 *  - terminal closed from __dock__      → real close (same)
 *  - non-terminal closed from anywhere  → real close
 *
 * "Re-dock" (parking a live tab in __dock__ without restarting its PTY) is an
 * explicit user action via redockTab — never a side effect of close.
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

describe("closeTab — terminal close semantics", () => {
  beforeEach(() => { localStorageStub.clear(); });

  it("closing terminal from GRID panel → real close: tab gone, never parked in __dock__, dock stays hidden", () => {
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

    usePanelStore.getState().closeTab("terminal:1", "panel-A");

    const state = usePanelStore.getState();
    // Tab removed from grid panel
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).not.toContain("terminal:1");
    // Tab NOT parked in the dock
    expect(state.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id)).not.toContain("terminal:1");
    // Dock must not be pulled open by a close
    expect(state.dock.visible).toBe(false);
    // Session key stripped — a reopen gets a fresh PTY
    expect(localStorageStub.getItem("ppm:terminal-session:terminal:1")).toBeNull();
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
    // Dock NOT shown
    expect(state.dock.visible).toBe(false);
    // Dock has no editor tab (only terminals are ever parked there)
    expect(state.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id)).not.toContain("editor:/bar.ts");
  });
});

describe("redockTab — explicit park (Move to Dock)", () => {
  beforeEach(() => { localStorageStub.clear(); });

  it("parks the terminal in __dock__, shows the dock, and keeps the session key", () => {
    const panel = makePanel("panel-A", [
      { id: "terminal:3", type: "terminal" },
      { id: "editor:/foo.ts", type: "editor" },
    ]);
    seedStore({
      gridPanels: [panel],
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      dockTabs: [],
      dockVisible: false,
    });
    localStorageStub.setItem("ppm:terminal-session:terminal:3", "session-abc");

    usePanelStore.getState().redockTab("terminal:3", "panel-A");

    const state = usePanelStore.getState();
    expect(state.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id)).toContain("terminal:3");
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).not.toContain("terminal:3");
    expect(state.dock.visible).toBe(true);
    // Session survives the reparent — no PTY restart
    expect(localStorageStub.getItem("ppm:terminal-session:terminal:3")).toBe("session-abc");
  });

  it("appends to a dock that already has tabs, without recursing into closeTab", () => {
    const panel = makePanel("panel-A", [{ id: "terminal:4", type: "terminal" }]);
    seedStore({
      gridPanels: [panel],
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      dockTabs: [{ id: "terminal:5", type: "terminal" }],
      dockVisible: false,
    });

    // Loop guard: redockTab uses the moveTab primitive; re-entering closeTab would
    // strip the session key and defeat the whole point of parking.
    let closeCalls = 0;
    const original = usePanelStore.getState().closeTab;
    usePanelStore.setState({
      closeTab: (tabId, panelId?) => { closeCalls++; original(tabId, panelId); },
    });

    usePanelStore.getState().redockTab("terminal:4", "panel-A");
    usePanelStore.setState({ closeTab: original });

    expect(closeCalls).toBe(0);
    const state = usePanelStore.getState();
    const dockTabIds = state.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id) ?? [];
    expect(dockTabIds).toContain("terminal:4");
    expect(dockTabIds).toContain("terminal:5");
    expect(state.dock.visible).toBe(true);
  });
});
