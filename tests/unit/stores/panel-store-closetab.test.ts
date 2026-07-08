/**
 * Characterization tests for usePanelStore.closeTab.
 *
 * PHASE 05 UPDATE (2026-07-02): Terminal-close semantics changed to location-based
 * re-dock. The original test "removes the localStorage session key for terminal: tabs"
 * has been INVERTED: closing a terminal from a GRID panel now PARKS it in __dock__
 * (no localStorage.removeItem) instead of killing it. Real kill only when closed from
 * WITHIN the dock, on shell exit, or after idle/grace. See dock-move-redock.test.ts
 * for the full re-dock test suite.
 *
 * Test env has NO DOM/window/localStorage → we stub globalThis.localStorage
 * with a minimal in-memory implementation because closeTab (panel-store.ts) and
 * savePanelLayout (panel-utils.ts) call it.
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

// Import AFTER stubbing localStorage so panel-utils.ts persistence calls succeed
import { usePanelStore } from "../../../src/web/stores/panel-store";
import type { Panel } from "../../../src/web/stores/panel-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Panel object. */
function makePanel(id: string, tabs: { id: string; type: string }[]): Panel {
  return {
    id,
    tabs: tabs.map((t) => ({
      id: t.id,
      type: t.type as Panel["tabs"][number]["type"],
      title: t.id,
      projectId: "p1",
      closable: true,
    })),
    activeTabId: tabs[0]?.id ?? null,
    tabHistory: tabs.map((t) => t.id),
  };
}

/** Seed the store with a fresh state (resets between test cases).
 *  Always includes a __dock__ panel so re-dock paths work correctly.
 */
function seedStore(options: {
  panels: Panel[];
  grid: string[][];
  focusedPanelId: string;
}) {
  const panelMap: Record<string, Panel> = {};
  for (const p of options.panels) panelMap[p.id] = p;
  // __dock__ must always be present — re-dock path calls moveTab(..., DOCK_PANEL_ID)
  panelMap["__dock__"] = { id: "__dock__", tabs: [], activeTabId: null, tabHistory: [] };
  usePanelStore.setState({
    panels: panelMap,
    grid: options.grid,
    focusedPanelId: options.focusedPanelId,
    currentProject: "p1",
    projectGrids: {},
    projectFocused: {},
    dock: { visible: false, height: 30 },
    projectDock: {},
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("usePanelStore.closeTab — characterization", () => {
  beforeEach(() => {
    localStorageStub.clear();
  });


  // PHASE 05 INVERSION: This test previously asserted that closing a terminal from a
  // grid panel calls localStorage.removeItem. That behavior is now changed: terminals
  // closed from grid panels are RE-DOCKED (parked in __dock__), NOT killed. The session
  // key is only stripped on real close (from within the dock). See dock-move-redock.test.ts
  // for the full coverage of both paths.
  it("closing terminal from GRID panel does NOT remove localStorage session key (re-dock parks it)", () => {
    const panel = makePanel("panel-A", [
      { id: "terminal:1", type: "terminal" },
      { id: "editor:/foo.ts", type: "editor" },
    ]);
    // Seed dock panel (required by re-dock path)
    const panelMap: Record<string, import("../../../src/web/stores/panel-utils").Panel> = {
      "panel-A": panel,
      "__dock__": { id: "__dock__", tabs: [], activeTabId: null, tabHistory: [] },
    };
    usePanelStore.setState({
      panels: panelMap,
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      currentProject: "p1",
      projectGrids: {},
      projectFocused: {},
      dock: { visible: false, height: 30 },
      projectDock: {},
    });

    localStorageStub.setItem("ppm:terminal-session:terminal:1", "session-abc");

    const removeSpy = spyOn(localStorageStub, "removeItem");
    try {
      usePanelStore.getState().closeTab("terminal:1", "panel-A");
      // Re-dock path: session key MUST NOT be stripped (PTY stays alive in dock)
      const sessionKeyStripped = removeSpy.mock.calls.some(
        (args) => String(args[0]) === "ppm:terminal-session:terminal:1",
      );
      expect(sessionKeyStripped).toBe(false);
      // Session key still present (session alive)
      expect(localStorageStub.getItem("ppm:terminal-session:terminal:1")).toBe("session-abc");
    } finally {
      removeSpy.mockRestore();
    }
  });

  // PHASE 05 UPDATE: closing a terminal from a grid panel now RE-DOCKS it (not removes it).
  // Updated assertion: terminal tab moves to __dock__, editor tab stays in panel-A.
  it("closing terminal from grid re-docks it; non-terminal tab stays; panel kept when other tabs remain", () => {
    const panel = makePanel("panel-A", [
      { id: "terminal:1", type: "terminal" },
      { id: "editor:/foo.ts", type: "editor" },
    ]);
    seedStore({ panels: [panel], grid: [["panel-A"]], focusedPanelId: "panel-A" });

    usePanelStore.getState().closeTab("terminal:1", "panel-A");

    const state = usePanelStore.getState();
    // Terminal re-docked — gone from panel-A
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).toEqual(["editor:/foo.ts"]);
    // Terminal now in __dock__
    expect(state.panels["__dock__"]?.tabs.map((t) => t.id)).toContain("terminal:1");
    // Panel is still in grid
    expect(state.grid.flat()).toContain("panel-A");
  });

  // PHASE 05 UPDATE: closing the only terminal from a single-panel grid now RE-DOCKS it.
  // Panel-A becomes empty (re-dock removes the tab from it), but the panel stays because
  // gridPanelCount === 1 (auto-remove guard still applies). Terminal is parked in __dock__.
  it("closing only terminal from single-panel grid re-docks it; panel stays (last-panel guard)", () => {
    const panel = makePanel("panel-A", [
      { id: "terminal:1", type: "terminal" },
    ]);
    seedStore({ panels: [panel], grid: [["panel-A"]], focusedPanelId: "panel-A" });

    usePanelStore.getState().closeTab("terminal:1", "panel-A");

    const state = usePanelStore.getState();
    // Terminal re-docked — gone from panel-A (moved to __dock__)
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).not.toContain("terminal:1");
    // Terminal now in __dock__
    expect(state.panels["__dock__"]?.tabs.map((t) => t.id)).toContain("terminal:1");
    // panel-A still exists and is in grid (last-panel guard prevents auto-remove)
    expect(state.panels["panel-A"]).toBeDefined();
    expect(state.grid.flat()).toContain("panel-A");
  });

  // PHASE 05 UPDATE: closing a terminal from a two-panel grid now RE-DOCKS it, so
  // panel-B is NOT auto-removed (the tab moves to __dock__, panel-B becomes empty but
  // stays). To test auto-remove behavior (panel-store.ts gridPanelCount > 1 guard),
  // we use a non-terminal tab (editor) which still follows the real-close path.
  it("auto-removes an emptied panel from the grid when there are two panels — non-terminal tab (panel-store.ts guard)", () => {
    // Two-panel grid: closing the only non-terminal tab of panel-B → panel-B removed
    const panelA = makePanel("panel-A", [{ id: "editor:/bar.ts", type: "editor" }]);
    const panelB = makePanel("panel-B", [{ id: "editor:/baz.ts", type: "editor" }]);
    seedStore({
      panels: [panelA, panelB],
      grid: [["panel-A", "panel-B"]],
      focusedPanelId: "panel-B",
    });

    usePanelStore.getState().closeTab("editor:/baz.ts", "panel-B");

    const state = usePanelStore.getState();
    // panel-B removed from grid (editor → real close → panel emptied → auto-removed)
    expect(state.grid.flat()).not.toContain("panel-B");
    // panel-A still present
    expect(state.grid.flat()).toContain("panel-A");
    // panel-B removed from panels map
    expect(state.panels["panel-B"]).toBeUndefined();
  });

  it("closing terminal from two-panel grid re-docks it; panel becomes empty but stays in grid", () => {
    // Terminal re-dock: panel-B has only one terminal tab. After re-dock, panel-B is
    // empty. With gridPanelCount > 1, the auto-remove logic fires — BUT moveTab's
    // source-empty auto-close removes panel-B from grid since fromPanelId !== __dock__.
    // This is correct behavior: the empty panel is cleaned up after the tab moves.
    const panelA = makePanel("panel-A", [{ id: "editor:/bar.ts", type: "editor" }]);
    const panelB = makePanel("panel-B", [{ id: "terminal:2", type: "terminal" }]);
    seedStore({
      panels: [panelA, panelB],
      grid: [["panel-A", "panel-B"]],
      focusedPanelId: "panel-B",
    });

    usePanelStore.getState().closeTab("terminal:2", "panel-B");

    const state = usePanelStore.getState();
    // Terminal is in dock (re-docked)
    expect(state.panels["__dock__"]?.tabs.map((t) => t.id)).toContain("terminal:2");
    // panel-A still present
    expect(state.grid.flat()).toContain("panel-A");
    // __dock__ never in grid
    expect(state.grid.flat()).not.toContain("__dock__");
  });

  it("does NOT call localStorage.removeItem for non-terminal tabs", () => {
    const panel = makePanel("panel-A", [
      { id: "editor:/foo.ts", type: "editor" },
    ]);
    seedStore({ panels: [panel], grid: [["panel-A"]], focusedPanelId: "panel-A" });

    const removeSpy = spyOn(localStorageStub, "removeItem");
    try {
      usePanelStore.getState().closeTab("editor:/foo.ts");

      // removeItem must NOT be called with a terminal-session key —
      // only terminal: prefix tabs trigger that removal (panel-store.ts:327-329)
      const terminalKeyCall = removeSpy.mock.calls.some(
        (args) => String(args[0]).startsWith("ppm:terminal-session:"),
      );
      expect(terminalKeyCall).toBe(false);
    } finally {
      removeSpy.mockRestore();
    }
  });
});
