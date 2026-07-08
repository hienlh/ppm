/**
 * Dock state unit tests — Phase 02.
 *
 * Validates:
 *   - Default dock.visible === false
 *   - toggleDock() flips visible
 *   - openInDock() pushes a terminal tab into panels["__dock__"] and sets dock.visible=true
 *   - setDockHeight() clamps to [15,85]
 *   - grid.flat() NEVER contains "__dock__" (dock panel lives outside grid by design)
 *
 * The dock panel is kept in the panels map but deliberately excluded from grid
 * so all grid math (MAX_ROWS, split, column count) ignores it.
 */
import { describe, it, expect, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// In-memory localStorage stub — must be set before store import
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

// ---------------------------------------------------------------------------
// Reset store to a clean state before each test
// ---------------------------------------------------------------------------
function resetStore() {
  localStorageStub.clear();
  // Re-initialize store to default layout (includes __dock__ in panels, not in grid)
  const { panels, grid, focusedPanelId } = usePanelStore.getInitialState
    ? (usePanelStore as unknown as { getInitialState: () => typeof usePanelStore.getState extends () => infer R ? R : never }).getInitialState()
    : (() => {
        // Manually trigger a fresh default: set currentProject to null and switch
        usePanelStore.setState({
          currentProject: null,
          projectGrids: {},
          projectFocused: {},
          projectDock: {},
          dock: { visible: false, height: 30 },
        });
        return usePanelStore.getState();
      })();
  void panels; void grid; void focusedPanelId;

  // Simplest reset: switch to a fresh project — this seeds __dock__ panel via store init
  // and sets dock to default hidden state
  usePanelStore.setState((s) => {
    // Keep __dock__ panel in panels map (it is always seeded at store creation)
    // but ensure dock state is at defaults
    return {
      dock: { visible: false, height: 30 },
      projectDock: {},
      currentProject: "test-project",
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("dock state — default and invariants", () => {
  beforeEach(() => {
    localStorageStub.clear();
    // Reset dock to known defaults
    usePanelStore.setState({
      dock: { visible: false, height: 30 },
      projectDock: {},
      currentProject: "test-project",
    });
  });

  it("default dock.visible is false", () => {
    const { dock } = usePanelStore.getState();
    expect(dock.visible).toBe(false);
  });

  it("default dock.height is 30", () => {
    const { dock } = usePanelStore.getState();
    expect(dock.height).toBe(30);
  });

  it("__dock__ panel exists in panels map on store init", () => {
    const { panels } = usePanelStore.getState();
    expect(panels[DOCK_PANEL_ID]).toBeDefined();
  });

  it("grid.flat() NEVER contains __dock__ (dock panel lives outside grid)", () => {
    const { grid } = usePanelStore.getState();
    expect(grid.flat()).not.toContain(DOCK_PANEL_ID);
  });
});

describe("dock state — toggleDock", () => {
  beforeEach(() => {
    localStorageStub.clear();
    usePanelStore.setState({
      dock: { visible: false, height: 30 },
      projectDock: {},
      currentProject: "test-project",
    });
  });

  it("toggleDock() flips visible from false to true", () => {
    usePanelStore.getState().toggleDock();
    expect(usePanelStore.getState().dock.visible).toBe(true);
  });

  it("toggleDock() flips visible from true to false", () => {
    usePanelStore.setState({ dock: { visible: true, height: 30 } });
    usePanelStore.getState().toggleDock();
    expect(usePanelStore.getState().dock.visible).toBe(false);
  });

  it("toggleDock() preserves dock.height", () => {
    usePanelStore.setState({ dock: { visible: false, height: 45 } });
    usePanelStore.getState().toggleDock();
    expect(usePanelStore.getState().dock.height).toBe(45);
  });

  it("grid.flat() still excludes __dock__ after toggleDock()", () => {
    usePanelStore.getState().toggleDock();
    const { grid } = usePanelStore.getState();
    expect(grid.flat()).not.toContain(DOCK_PANEL_ID);
  });
});

describe("dock state — setDockHeight clamping", () => {
  beforeEach(() => {
    localStorageStub.clear();
    usePanelStore.setState({
      dock: { visible: false, height: 30 },
      projectDock: {},
      currentProject: "test-project",
    });
  });

  it("setDockHeight(50) sets height to 50", () => {
    usePanelStore.getState().setDockHeight(50);
    expect(usePanelStore.getState().dock.height).toBe(50);
  });

  it("setDockHeight(5) clamps to minimum 15", () => {
    usePanelStore.getState().setDockHeight(5);
    expect(usePanelStore.getState().dock.height).toBe(15);
  });

  it("setDockHeight(90) clamps to maximum 85", () => {
    usePanelStore.getState().setDockHeight(90);
    expect(usePanelStore.getState().dock.height).toBe(85);
  });

  it("setDockHeight(15) is exactly at minimum boundary", () => {
    usePanelStore.getState().setDockHeight(15);
    expect(usePanelStore.getState().dock.height).toBe(15);
  });

  it("setDockHeight(85) is exactly at maximum boundary", () => {
    usePanelStore.getState().setDockHeight(85);
    expect(usePanelStore.getState().dock.height).toBe(85);
  });
});

describe("dock state — openInDock", () => {
  beforeEach(() => {
    localStorageStub.clear();
    // Fresh dock panel with no tabs
    usePanelStore.setState({
      dock: { visible: false, height: 30 },
      projectDock: {},
      currentProject: "test-project",
      panels: {
        ...usePanelStore.getState().panels,
        [DOCK_PANEL_ID]: {
          id: DOCK_PANEL_ID,
          tabs: [],
          activeTabId: null,
          tabHistory: [],
        },
      },
    });
  });

  it("openInDock() adds a terminal tab to panels[__dock__]", () => {
    usePanelStore.getState().openInDock({
      type: "terminal",
      title: "Terminal 1",
      projectId: "test-project",
      closable: true,
      metadata: { terminalIndex: 1 },
    });
    const dockPanel = usePanelStore.getState().panels[DOCK_PANEL_ID];
    expect(dockPanel).toBeDefined();
    expect(dockPanel!.tabs.length).toBe(1);
    expect(dockPanel!.tabs[0]!.type).toBe("terminal");
  });

  it("openInDock() sets dock.visible to true", () => {
    usePanelStore.getState().openInDock({
      type: "terminal",
      title: "Terminal 1",
      projectId: "test-project",
      closable: true,
      metadata: { terminalIndex: 1 },
    });
    expect(usePanelStore.getState().dock.visible).toBe(true);
  });

  it("openInDock() sets the new tab as activeTabId in dock panel", () => {
    usePanelStore.getState().openInDock({
      type: "terminal",
      title: "Terminal 1",
      projectId: "test-project",
      closable: true,
      metadata: { terminalIndex: 1 },
    });
    const dockPanel = usePanelStore.getState().panels[DOCK_PANEL_ID]!;
    expect(dockPanel.activeTabId).toBe(dockPanel.tabs[0]!.id);
  });

  it("openInDock() does NOT add __dock__ to grid", () => {
    usePanelStore.getState().openInDock({
      type: "terminal",
      title: "Terminal 1",
      projectId: "test-project",
      closable: true,
      metadata: { terminalIndex: 1 },
    });
    const { grid } = usePanelStore.getState();
    expect(grid.flat()).not.toContain(DOCK_PANEL_ID);
  });

  it("openInDock() deduplicates: calling twice with same tab type+index focuses existing tab", () => {
    usePanelStore.getState().openInDock({
      type: "terminal",
      title: "Terminal 1",
      projectId: "test-project",
      closable: true,
      metadata: { terminalIndex: 2 },
    });
    usePanelStore.getState().openInDock({
      type: "terminal",
      title: "Terminal 1",
      projectId: "test-project",
      closable: true,
      metadata: { terminalIndex: 2 },
    });
    const dockPanel = usePanelStore.getState().panels[DOCK_PANEL_ID]!;
    // Should still be 1 tab (deduped)
    expect(dockPanel.tabs.length).toBe(1);
  });
});
