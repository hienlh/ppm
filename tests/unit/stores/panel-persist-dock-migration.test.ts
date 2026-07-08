/**
 * Persistence + migration tests for dock state in panel-utils.
 *
 * Validates:
 *   - loadPanelLayout on a JSON blob WITHOUT dock → dock==={visible:false,height:30}
 *     and an empty dock panel is synthesized
 *   - A blob WITH a dock terminal round-trips through savePanelLayout→loadPanelLayout
 *   - Non-allowed tab types are stripped from dockPanel.tabs on load (defensive filter:
 *     only "terminal" and "system-monitor" are allowed in the dock)
 *
 * The defensive type filter prevents a crafted persisted blob from opening arbitrary
 * tab types in a privileged-looking dock.
 */
import { describe, it, expect, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// In-memory localStorage stub — must be set before store/utils import
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
import {
  savePanelLayout,
  loadPanelLayout,
  DOCK_PANEL_ID,
  createDockPanel,
} from "../../../src/web/stores/panel-utils";
import type { PanelLayout, DockState } from "../../../src/web/stores/panel-utils";
import type { Tab } from "../../../src/web/stores/tab-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const PROJECT = "test-migrate-project";

function makeTab(overrides: Partial<Tab> & Pick<Tab, "id" | "type">): Tab {
  return {
    title: overrides.id,
    projectId: PROJECT,
    closable: true,
    metadata: {},
    ...overrides,
  };
}

/** Build a minimal PanelLayout without dock fields (old persisted format) */
function legacyLayout(): Omit<PanelLayout, "dock" | "dockPanel"> {
  const panelId = "panel-legacy-1";
  return {
    panels: {
      [panelId]: {
        id: panelId,
        tabs: [makeTab({ id: "editor:/foo.ts", type: "editor" })],
        activeTabId: "editor:/foo.ts",
        tabHistory: ["editor:/foo.ts"],
      },
    },
    grid: [[panelId]],
    focusedPanelId: panelId,
  };
}

// ---------------------------------------------------------------------------
// Tests: migration defaults (no dock field in stored blob)
// ---------------------------------------------------------------------------
describe("loadPanelLayout — dock migration defaults", () => {
  beforeEach(() => localStorageStub.clear());

  it("returns dock={visible:false,height:30} when stored blob has no dock field", () => {
    const layout = legacyLayout();
    localStorageStub.setItem(`ppm-panels-${PROJECT}`, JSON.stringify(layout));

    const loaded = loadPanelLayout(PROJECT);
    expect(loaded).not.toBeNull();
    expect(loaded!.dock).toEqual({ visible: false, height: 30 });
  });

  it("synthesizes an empty dockPanel when stored blob has no dockPanel field", () => {
    const layout = legacyLayout();
    localStorageStub.setItem(`ppm-panels-${PROJECT}`, JSON.stringify(layout));

    const loaded = loadPanelLayout(PROJECT);
    expect(loaded).not.toBeNull();
    const dp = loaded!.dockPanel;
    expect(dp).toBeDefined();
    expect(dp!.id).toBe(DOCK_PANEL_ID);
    expect(dp!.tabs).toHaveLength(0);
    expect(dp!.activeTabId).toBeNull();
  });

  it("preserves existing grid panels when migrating dock defaults", () => {
    const layout = legacyLayout();
    localStorageStub.setItem(`ppm-panels-${PROJECT}`, JSON.stringify(layout));

    const loaded = loadPanelLayout(PROJECT);
    expect(loaded!.grid).toEqual([["panel-legacy-1"]]);
    expect(loaded!.panels["panel-legacy-1"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: round-trip (save → load preserves dock state)
// ---------------------------------------------------------------------------
describe("savePanelLayout / loadPanelLayout — dock round-trip", () => {
  beforeEach(() => localStorageStub.clear());

  it("round-trips dock state (visible=true, height=40) through save→load", () => {
    const panelId = "panel-rt-1";
    const dockPanel = createDockPanel();
    dockPanel.tabs = [makeTab({ id: "terminal:1", type: "terminal" })];
    dockPanel.activeTabId = "terminal:1";
    dockPanel.tabHistory = ["terminal:1"];

    const dock: DockState = { visible: true, height: 40 };
    const layout: PanelLayout = {
      panels: {
        [panelId]: {
          id: panelId,
          tabs: [makeTab({ id: "editor:/bar.ts", type: "editor" })],
          activeTabId: "editor:/bar.ts",
          tabHistory: ["editor:/bar.ts"],
        },
      },
      grid: [[panelId]],
      focusedPanelId: panelId,
      dock,
      dockPanel,
    };

    savePanelLayout(PROJECT, layout);
    const loaded = loadPanelLayout(PROJECT);

    expect(loaded).not.toBeNull();
    expect(loaded!.dock).toEqual({ visible: true, height: 40 });
  });

  it("round-trips dockPanel terminal tab through save→load", () => {
    const panelId = "panel-rt-2";
    const dockPanel = createDockPanel();
    const termTab = makeTab({ id: "terminal:3", type: "terminal" });
    dockPanel.tabs = [termTab];
    dockPanel.activeTabId = "terminal:3";
    dockPanel.tabHistory = ["terminal:3"];

    const layout: PanelLayout = {
      panels: {
        [panelId]: {
          id: panelId,
          tabs: [makeTab({ id: "editor:/baz.ts", type: "editor" })],
          activeTabId: "editor:/baz.ts",
          tabHistory: ["editor:/baz.ts"],
        },
      },
      grid: [[panelId]],
      focusedPanelId: panelId,
      dock: { visible: true, height: 35 },
      dockPanel,
    };

    savePanelLayout(PROJECT, layout);
    const loaded = loadPanelLayout(PROJECT);

    expect(loaded!.dockPanel).toBeDefined();
    expect(loaded!.dockPanel!.tabs).toHaveLength(1);
    expect(loaded!.dockPanel!.tabs[0]!.type).toBe("terminal");
    expect(loaded!.dockPanel!.tabs[0]!.id).toBe("terminal:3");
  });

  it("round-trips system-monitor tab through save→load (allowed dock type)", () => {
    const panelId = "panel-rt-3";
    const dockPanel = createDockPanel();
    dockPanel.tabs = [makeTab({ id: "system-monitor", type: "system-monitor" })];
    dockPanel.activeTabId = "system-monitor";
    dockPanel.tabHistory = ["system-monitor"];

    const layout: PanelLayout = {
      panels: {
        [panelId]: {
          id: panelId,
          tabs: [],
          activeTabId: null,
          tabHistory: [],
        },
      },
      grid: [[panelId]],
      focusedPanelId: panelId,
      dock: { visible: false, height: 30 },
      dockPanel,
    };

    savePanelLayout(PROJECT, layout);
    const loaded = loadPanelLayout(PROJECT);

    expect(loaded!.dockPanel!.tabs).toHaveLength(1);
    expect(loaded!.dockPanel!.tabs[0]!.type).toBe("system-monitor");
  });
});

// ---------------------------------------------------------------------------
// Tests: defensive type filtering on load
// ---------------------------------------------------------------------------
describe("loadPanelLayout — dock tab type filtering", () => {
  beforeEach(() => localStorageStub.clear());

  it("strips non-allowed tab types (editor, chat, settings) from dockPanel.tabs on load", () => {
    const panelId = "panel-filter-1";
    const dockPanel = createDockPanel();
    dockPanel.tabs = [
      makeTab({ id: "terminal:1", type: "terminal" }),       // allowed
      makeTab({ id: "editor:/x.ts", type: "editor" }),       // NOT allowed
      makeTab({ id: "settings", type: "settings" }),         // NOT allowed
      makeTab({ id: "system-monitor", type: "system-monitor" }), // allowed
    ];
    dockPanel.activeTabId = "terminal:1";
    dockPanel.tabHistory = ["terminal:1", "editor:/x.ts", "settings", "system-monitor"];

    const layout: PanelLayout = {
      panels: {
        [panelId]: {
          id: panelId,
          tabs: [],
          activeTabId: null,
          tabHistory: [],
        },
      },
      grid: [[panelId]],
      focusedPanelId: panelId,
      dock: { visible: true, height: 30 },
      dockPanel,
    };

    // Write raw to bypass savePanelLayout filtering (test the load-time filter specifically)
    localStorageStub.setItem(`ppm-panels-${PROJECT}`, JSON.stringify({ ...layout, updatedAt: new Date().toISOString() }));

    const loaded = loadPanelLayout(PROJECT);
    expect(loaded).not.toBeNull();
    const loadedTabs = loaded!.dockPanel!.tabs;
    // Only terminal and system-monitor should survive
    expect(loadedTabs.map((t) => t.type).sort()).toEqual(["system-monitor", "terminal"]);
    expect(loadedTabs.find((t) => t.type === "editor")).toBeUndefined();
    expect(loadedTabs.find((t) => t.type === "settings")).toBeUndefined();
  });

  it("strips ALL non-allowed tabs → dockPanel.tabs empty when no allowed types present", () => {
    const panelId = "panel-filter-2";
    const dockPanel = createDockPanel();
    dockPanel.tabs = [
      makeTab({ id: "editor:/y.ts", type: "editor" }),
      makeTab({ id: "settings", type: "settings" }),
    ];
    dockPanel.activeTabId = "editor:/y.ts";
    dockPanel.tabHistory = ["editor:/y.ts", "settings"];

    const layout: PanelLayout = {
      panels: { [panelId]: { id: panelId, tabs: [], activeTabId: null, tabHistory: [] } },
      grid: [[panelId]],
      focusedPanelId: panelId,
      dock: { visible: true, height: 30 },
      dockPanel,
    };

    localStorageStub.setItem(`ppm-panels-${PROJECT}`, JSON.stringify({ ...layout, updatedAt: new Date().toISOString() }));

    const loaded = loadPanelLayout(PROJECT);
    expect(loaded!.dockPanel!.tabs).toHaveLength(0);
    // activeTabId should be cleared since all tabs were stripped
    expect(loaded!.dockPanel!.activeTabId).toBeNull();
  });
});
