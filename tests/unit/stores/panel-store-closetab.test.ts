/**
 * Characterization tests for usePanelStore.closeTab.
 *
 * Close ends a terminal wherever its tab lives — grid panel or dock. Parking a live
 * terminal in the dock is the separate, explicit redockTab action; see
 * dock-move-redock.test.ts for that suite.
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
 *  Always includes a __dock__ panel so dock assertions have something to read.
 */
function seedStore(options: {
  panels: Panel[];
  grid: string[][];
  focusedPanelId: string;
}) {
  const panelMap: Record<string, Panel> = {};
  for (const p of options.panels) panelMap[p.id] = p;
  // __dock__ must always be present so "not parked in the dock" assertions can read it
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


  it("removes the localStorage session key when closing a terminal from a GRID panel", () => {
    const panel = makePanel("panel-A", [
      { id: "terminal:1", type: "terminal" },
      { id: "editor:/foo.ts", type: "editor" },
    ]);
    seedStore({ panels: [panel], grid: [["panel-A"]], focusedPanelId: "panel-A" });

    localStorageStub.setItem("ppm:terminal-session:terminal:1", "session-abc");

    const removeSpy = spyOn(localStorageStub, "removeItem");
    try {
      usePanelStore.getState().closeTab("terminal:1", "panel-A");
      expect(removeSpy).toHaveBeenCalledWith("ppm:terminal-session:terminal:1");
      expect(localStorageStub.getItem("ppm:terminal-session:terminal:1")).toBeNull();
    } finally {
      removeSpy.mockRestore();
    }
  });

  it("closing terminal from grid removes it; non-terminal tab stays; panel kept when other tabs remain", () => {
    const panel = makePanel("panel-A", [
      { id: "terminal:1", type: "terminal" },
      { id: "editor:/foo.ts", type: "editor" },
    ]);
    seedStore({ panels: [panel], grid: [["panel-A"]], focusedPanelId: "panel-A" });

    usePanelStore.getState().closeTab("terminal:1", "panel-A");

    const state = usePanelStore.getState();
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).toEqual(["editor:/foo.ts"]);
    // Never parked in the dock
    expect(state.panels["__dock__"]?.tabs.map((t) => t.id)).not.toContain("terminal:1");
    // Panel is still in grid
    expect(state.grid.flat()).toContain("panel-A");
  });

  it("closing only terminal from single-panel grid empties it; panel stays (last-panel guard)", () => {
    const panel = makePanel("panel-A", [
      { id: "terminal:1", type: "terminal" },
    ]);
    seedStore({ panels: [panel], grid: [["panel-A"]], focusedPanelId: "panel-A" });

    usePanelStore.getState().closeTab("terminal:1", "panel-A");

    const state = usePanelStore.getState();
    expect(state.panels["panel-A"]?.tabs).toEqual([]);
    expect(state.panels["__dock__"]?.tabs.map((t) => t.id)).not.toContain("terminal:1");
    // panel-A still exists and is in grid (last-panel guard prevents auto-remove)
    expect(state.panels["panel-A"]).toBeDefined();
    expect(state.grid.flat()).toContain("panel-A");
  });

  it("auto-removes an emptied panel from the grid when there are two panels (panel-store.ts guard)", () => {
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

  it("closing the only terminal of a two-panel grid removes that panel from the grid", () => {
    const panelA = makePanel("panel-A", [{ id: "editor:/bar.ts", type: "editor" }]);
    const panelB = makePanel("panel-B", [{ id: "terminal:2", type: "terminal" }]);
    seedStore({
      panels: [panelA, panelB],
      grid: [["panel-A", "panel-B"]],
      focusedPanelId: "panel-B",
    });

    usePanelStore.getState().closeTab("terminal:2", "panel-B");

    const state = usePanelStore.getState();
    // Terminal gone for good — not parked in the dock
    expect(state.panels["__dock__"]?.tabs.map((t) => t.id)).not.toContain("terminal:2");
    // Emptied panel-B is cleaned up, panel-A survives
    expect(state.grid.flat()).not.toContain("panel-B");
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
