/**
 * "No stuck empty panel" invariant.
 *
 * A grid panel can end up holding only another project's tab (e.g. a notification
 * whose project name does not resolve). The tab bar filters those out, so the panel
 * shows no tabs — and closeTab, the only thing that removes an emptied panel, can
 * never run for it. The panel then renders as a blank slot forever.
 *
 * These cover the two halves of the fix: the restore path heals such a layout, and
 * closePanel is a working manual escape hatch.
 *
 * Test env has NO DOM/window/localStorage → stub globalThis.localStorage before the
 * store import, same as panel-store-closetab.test.ts.
 */
import { describe, it, expect, beforeEach } from "bun:test";

const memStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (key: string) => memStore[key] ?? null,
  setItem: (key: string, value: string) => { memStore[key] = value; },
  removeItem: (key: string) => { delete memStore[key]; },
  clear: () => { for (const k of Object.keys(memStore)) delete memStore[k]; },
};
(globalThis as unknown as { localStorage: typeof localStorageStub }).localStorage = localStorageStub;

import { usePanelStore } from "../../../src/web/stores/panel-store";
import { visibleTabs, createDockPanel, type Panel } from "../../../src/web/stores/panel-utils";

const PROJECT = "proj-a";

/** Build a Panel whose tabs belong to `projectId`. */
function makePanel(id: string, tabIds: string[], projectId: string | null): Panel {
  return {
    id,
    tabs: tabIds.map((t) => ({
      id: t,
      type: "chat" as Panel["tabs"][number]["type"],
      title: t,
      projectId,
      closable: true,
    })),
    activeTabId: tabIds[0] ?? null,
    tabHistory: [...tabIds],
  };
}

/** Persist a layout the way the app does, then load it via switchProject. */
function seedPersistedLayout(panels: Panel[], grid: string[][]) {
  const panelMap: Record<string, Panel> = {};
  for (const p of panels) panelMap[p.id] = p;
  localStorageStub.setItem(
    `ppm-panels-${PROJECT}`,
    JSON.stringify({
      panels: panelMap,
      grid,
      focusedPanelId: grid.flat()[0],
      dock: { visible: false, height: 30 },
      dockPanel: createDockPanel(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

beforeEach(() => {
  localStorageStub.clear();
  // currentProject must differ from PROJECT or switchProject short-circuits,
  // and projectGrids must be empty or it restores from the in-memory snapshot
  // instead of reading localStorage.
  usePanelStore.setState({ currentProject: "__none__", projectGrids: {}, projectFocused: {} });
});

describe("restore heals a panel wedged by a foreign-project tab", () => {
  it("drops the foreign tab and removes the panel it leaves empty", () => {
    seedPersistedLayout(
      [makePanel("p-good", ["chat:a", "chat:b"], PROJECT), makePanel("p-ghost", ["chat:x"], "Unknown")],
      [["p-good", "p-ghost"]],
    );

    usePanelStore.getState().switchProject(PROJECT);

    const { grid, panels } = usePanelStore.getState();
    expect(grid.flat()).toEqual(["p-good"]);
    expect(panels["p-ghost"]).toBeUndefined();
    expect(panels["p-good"]!.tabs.map((t) => t.id)).toEqual(["chat:a", "chat:b"]);
  });

  it("moves focus off the removed panel", () => {
    seedPersistedLayout(
      [makePanel("p-good", ["chat:a"], PROJECT), makePanel("p-ghost", ["chat:x"], "Unknown")],
      [["p-ghost", "p-good"]], // focusedPanelId seeds to grid.flat()[0] === p-ghost
    );

    usePanelStore.getState().switchProject(PROJECT);

    expect(usePanelStore.getState().focusedPanelId).toBe("p-good");
  });

  it("writes the healed layout back so the repair survives the next load", () => {
    seedPersistedLayout(
      [makePanel("p-good", ["chat:a"], PROJECT), makePanel("p-ghost", ["chat:x"], "Unknown")],
      [["p-good", "p-ghost"]],
    );

    usePanelStore.getState().switchProject(PROJECT);

    const persisted = JSON.parse(localStorageStub.getItem(`ppm-panels-${PROJECT}`)!);
    expect(persisted.grid.flat()).toEqual(["p-good"]);
    expect(persisted.panels["p-ghost"]).toBeUndefined();
  });

  it("keeps the last panel even when its only tab is foreign", () => {
    // Nothing left to render into otherwise — mirrors VS Code refusing to remove
    // the last root group.
    seedPersistedLayout([makePanel("p-only", ["chat:x"], "Unknown")], [["p-only"]]);

    usePanelStore.getState().switchProject(PROJECT);

    const { grid, panels } = usePanelStore.getState();
    expect(grid.flat()).toEqual(["p-only"]);
    expect(panels["p-only"]!.tabs).toEqual([]);
  });

  it("leaves a healthy split untouched", () => {
    seedPersistedLayout(
      [makePanel("p1", ["chat:a"], PROJECT), makePanel("p2", ["chat:b"], PROJECT)],
      [["p1", "p2"]],
    );

    usePanelStore.getState().switchProject(PROJECT);

    expect(usePanelStore.getState().grid.flat()).toEqual(["p1", "p2"]);
  });
});

describe("closePanel", () => {
  beforeEach(() => {
    seedPersistedLayout(
      [makePanel("p1", ["chat:a"], PROJECT), makePanel("p2", ["chat:b"], PROJECT)],
      [["p1", "p2"]],
    );
    usePanelStore.getState().switchProject(PROJECT);
  });

  it("removes the panel and merges its tabs into the neighbor", () => {
    usePanelStore.getState().closePanel("p2");

    const { grid, panels } = usePanelStore.getState();
    expect(grid.flat()).toEqual(["p1"]);
    expect(panels["p2"]).toBeUndefined();
    expect(panels["p1"]!.tabs.map((t) => t.id)).toEqual(["chat:a", "chat:b"]);
    expect(usePanelStore.getState().focusedPanelId).toBe("p1");
  });

  it("refuses to remove the last panel in the grid", () => {
    usePanelStore.getState().closePanel("p2");
    usePanelStore.getState().closePanel("p1");

    expect(usePanelStore.getState().grid.flat()).toEqual(["p1"]);
  });
});

describe("visibleTabs", () => {
  it("hides another project's tabs but keeps project-less ones", () => {
    const tabs = makePanel("p", ["a"], PROJECT).tabs
      .concat(makePanel("p", ["b"], "other").tabs)
      .concat(makePanel("p", ["c"], null).tabs);

    expect(visibleTabs(tabs, PROJECT).map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("keeps everything when there is no active project to filter by", () => {
    const tabs = makePanel("p", ["a"], PROJECT).tabs.concat(makePanel("p", ["b"], "other").tabs);

    expect(visibleTabs(tabs, null).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("treats the __global__ layout key the same as null", () => {
    // TabBar passes null for "no active project" while the layout key is the
    // "__global__" sentinel. If these disagreed, EditorPanel would call a panel
    // empty while TabBar still rendered its chips — tabs above a blank body.
    const tabs = makePanel("p", ["a"], PROJECT).tabs.concat(makePanel("p", ["b"], null).tabs);

    expect(visibleTabs(tabs, "__global__").map((t) => t.id)).toEqual(["a", "b"]);
  });
});
