/**
 * Tests for the return trip: redockFromWindow, an emptied window panel, and a project
 * being reloaded while one of its tabs is detached.
 *
 * The rule everywhere: a tab must always end up somewhere the user can reach it, and
 * `focusedPanelId` must always be a grid panel afterwards.
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
import { useWindowStore } from "../../../src/web/components/floating-window/window-store";
import { DOCK_PANEL_ID, windowPanelId } from "../../../src/web/stores/panel-utils";
import type { Panel } from "../../../src/web/stores/panel-utils";

function makePanel(id: string, tabSpecs: { id: string; type: string; projectId?: string }[]): Panel {
  return {
    id,
    tabs: tabSpecs.map((t) => ({
      id: t.id,
      type: t.type as Panel["tabs"][number]["type"],
      title: t.id,
      projectId: t.projectId ?? "proj1",
      closable: true,
    })),
    activeTabId: tabSpecs[0]?.id ?? null,
    tabHistory: tabSpecs.map((t) => t.id),
  };
}

function seedStore(panels: Panel[], grid: string[][], focusedPanelId: string, dockTabs: { id: string; type: string }[] = []) {
  const panelMap: Record<string, Panel> = {};
  for (const p of panels) panelMap[p.id] = p;
  panelMap[DOCK_PANEL_ID] = makePanel(DOCK_PANEL_ID, dockTabs);
  usePanelStore.setState({
    panels: panelMap,
    grid,
    focusedPanelId,
    currentProject: "proj1",
    projectGrids: { proj1: grid },
    projectFocused: { proj1: focusedPanelId },
    dock: { visible: false, height: 30 },
    projectDock: {},
  });
}

/** Detach a tab and hand back the ids both sides of the round trip need. */
function popOut(tabId: string, fromPanelId: string): { windowId: string; panelId: string } {
  const windowId = usePanelStore.getState().popOutTab(tabId, fromPanelId)!;
  return { windowId, panelId: windowPanelId(windowId) };
}

beforeEach(() => {
  localStorageStub.clear();
  useWindowStore.setState({ windows: {}, restored: true });
});

describe("redockFromWindow", () => {
  it("returns the tab to its origin panel and deletes the window panel", () => {
    seedStore(
      [makePanel("panel-A", [{ id: "terminal:1", type: "terminal" }, { id: "editor:/a.ts", type: "editor" }])],
      [["panel-A"]],
      "panel-A",
    );
    const { windowId, panelId } = popOut("terminal:1", "panel-A");

    usePanelStore.getState().redockFromWindow(windowId, "panel-A");

    const state = usePanelStore.getState();
    expect(state.panels[panelId]).toBeUndefined();
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).toContain("terminal:1");
    expect(state.focusedPanelId).toBe("panel-A");
  });

  it("falls back to the focused grid panel when the origin panel is gone", () => {
    seedStore(
      [
        makePanel("panel-A", [{ id: "terminal:1", type: "terminal" }]),
        makePanel("panel-B", [{ id: "editor:/b.ts", type: "editor" }]),
      ],
      [["panel-A", "panel-B"]],
      "panel-A",
    );
    // Popping the only tab out auto-closes panel-A, so its origin no longer exists.
    const { windowId } = popOut("terminal:1", "panel-A");
    expect(usePanelStore.getState().panels["panel-A"]).toBeUndefined();

    usePanelStore.getState().redockFromWindow(windowId, "panel-A");

    const state = usePanelStore.getState();
    expect(state.panels["panel-B"]?.tabs.map((t) => t.id)).toContain("terminal:1");
    expect(state.focusedPanelId).toBe("panel-B");
  });

  it("never re-docks into the dock when the dock happens to be focused", () => {
    seedStore([makePanel("panel-A", [{ id: "editor:/a.ts", type: "editor" }])], [["panel-A"]], "panel-A", [
      { id: "terminal:1", type: "terminal" },
    ]);
    const { windowId } = popOut("terminal:1", DOCK_PANEL_ID);
    // The dock is off-grid, so it can never be the focus fallback.
    usePanelStore.setState({ focusedPanelId: DOCK_PANEL_ID });

    usePanelStore.getState().redockFromWindow(windowId, null);

    const state = usePanelStore.getState();
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).toContain("terminal:1");
    expect(state.focusedPanelId).toBe("panel-A");
  });

  it("re-docks into the origin dock when that is where the tab came from", () => {
    seedStore([makePanel("panel-A", [{ id: "editor:/a.ts", type: "editor" }])], [["panel-A"]], "panel-A", [
      { id: "terminal:1", type: "terminal" },
    ]);
    const { windowId } = popOut("terminal:1", DOCK_PANEL_ID);

    usePanelStore.getState().redockFromWindow(windowId, DOCK_PANEL_ID);

    const state = usePanelStore.getState();
    expect(state.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id)).toContain("terminal:1");
    // Focus still has to be a grid panel — the dock never holds it.
    expect(state.focusedPanelId).toBe("panel-A");
  });

  it("is a no-op when the window panel is already gone", () => {
    seedStore([makePanel("panel-A", [{ id: "editor:/a.ts", type: "editor" }])], [["panel-A"]], "panel-A");
    const before = usePanelStore.getState().panels;

    usePanelStore.getState().redockFromWindow("win-does-not-exist", "panel-A");

    expect(usePanelStore.getState().panels).toBe(before);
  });

  it("closes the window it emptied, so an unmounted body cannot leave a ghost behind", () => {
    // The body can unmount without the window closing — dropping below `md` unmounts the
    // whole desktop window layer. Without this the entry survives in the window store and
    // in `ppm-windows`, and comes back empty and unfillable.
    seedStore(
      [makePanel("panel-A", [{ id: "terminal:1", type: "terminal" }, { id: "editor:/a.ts", type: "editor" }])],
      [["panel-A"]],
      "panel-A",
    );
    const { windowId } = popOut("terminal:1", "panel-A");
    expect(useWindowStore.getState().windows[windowId]).toBeTruthy();

    usePanelStore.getState().redockFromWindow(windowId, "panel-A");

    expect(useWindowStore.getState().windows[windowId]).toBeUndefined();
    expect(localStorageStub.getItem("ppm-windows") ?? "").not.toContain(windowId);
  });

  it("stays a no-op on the normal close path, where the window is already gone", () => {
    seedStore(
      [makePanel("panel-A", [{ id: "terminal:1", type: "terminal" }, { id: "editor:/a.ts", type: "editor" }])],
      [["panel-A"]],
      "panel-A",
    );
    const { windowId } = popOut("terminal:1", "panel-A");
    // What the titlebar × does: the window goes first, the body's cleanup re-docks after.
    useWindowStore.getState().close(windowId);
    const windowsBefore = useWindowStore.getState().windows;

    usePanelStore.getState().redockFromWindow(windowId, "panel-A");

    expect(useWindowStore.getState().windows).toBe(windowsBefore);
    expect(usePanelStore.getState().panels["panel-A"]?.tabs.map((t) => t.id)).toContain("terminal:1");
  });
});

describe("closeTab on a window panel", () => {
  it("deletes the panel and closes the window even when the grid holds a single panel", () => {
    seedStore(
      [makePanel("panel-A", [{ id: "terminal:1", type: "terminal" }, { id: "editor:/a.ts", type: "editor" }])],
      [["panel-A"]],
      "panel-A",
    );
    const { windowId, panelId } = popOut("terminal:1", "panel-A");
    expect(usePanelStore.getState().grid.flat()).toHaveLength(1);

    usePanelStore.getState().closeTab("terminal:1", panelId);

    expect(usePanelStore.getState().panels[panelId]).toBeUndefined();
    expect(useWindowStore.getState().windows[windowId]).toBeUndefined();
  });

  it("keeps the window open while the panel still holds another tab", () => {
    seedStore(
      [makePanel("panel-A", [
        { id: "terminal:1", type: "terminal" },
        { id: "terminal:2", type: "terminal" },
        { id: "editor:/a.ts", type: "editor" },
      ])],
      [["panel-A"]],
      "panel-A",
    );
    const { windowId, panelId } = popOut("terminal:1", "panel-A");
    usePanelStore.getState().moveTab("terminal:2", "panel-A", panelId);

    usePanelStore.getState().closeTab("terminal:1", panelId);

    expect(usePanelStore.getState().panels[panelId]?.tabs.map((t) => t.id)).toEqual(["terminal:2"]);
    expect(useWindowStore.getState().windows[windowId]).toBeDefined();
  });
});

describe("reloadProject with a detached tab", () => {
  it("drops the project's window panel and closes its window", () => {
    seedStore(
      [makePanel("panel-A", [{ id: "terminal:1", type: "terminal" }, { id: "editor:/a.ts", type: "editor" }])],
      [["panel-A"]],
      "panel-A",
    );
    const { windowId, panelId } = popOut("terminal:1", "panel-A");

    usePanelStore.getState().reloadProject("proj1");

    expect(usePanelStore.getState().panels[panelId]).toBeUndefined();
    expect(useWindowStore.getState().windows[windowId]).toBeUndefined();
  });

  it("leaves another project's detached tab alone", () => {
    seedStore(
      [makePanel("panel-A", [
        { id: "terminal:1", type: "terminal", projectId: "proj2" },
        { id: "editor:/a.ts", type: "editor" },
      ])],
      [["panel-A"]],
      "panel-A",
    );
    const { windowId, panelId } = popOut("terminal:1", "panel-A");

    usePanelStore.getState().reloadProject("proj1");

    expect(usePanelStore.getState().panels[panelId]?.tabs.map((t) => t.id)).toEqual(["terminal:1"]);
    expect(useWindowStore.getState().windows[windowId]).toBeDefined();
  });
});
