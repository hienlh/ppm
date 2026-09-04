/**
 * Tests for popOutTab — detaching a tab into a floating window.
 *
 * Invariants locked here:
 *  - the window panel lives in `panels` and NEVER in `grid`
 *  - `focusedPanelId` stays on a grid panel, so the next openTab() with no explicit
 *    panel lands in the grid and not inside the floating window
 *  - a rejected request (system-monitor, window cap) mutates nothing at all
 */
import { describe, it, expect, beforeEach } from "bun:test";

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
import { useWindowStore } from "../../../src/web/components/floating-window/window-store";
import { MAX_WINDOWS } from "../../../src/web/components/floating-window/window-geometry";
import { DOCK_PANEL_ID, isWindowPanelId, windowPanelId } from "../../../src/web/stores/panel-utils";
import type { Panel } from "../../../src/web/stores/panel-utils";

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

function seedStore(panels: Panel[], grid: string[][], focusedPanelId: string) {
  const panelMap: Record<string, Panel> = {};
  for (const p of panels) panelMap[p.id] = p;
  panelMap[DOCK_PANEL_ID] = makePanel(DOCK_PANEL_ID, []);
  usePanelStore.setState({
    panels: panelMap,
    grid,
    focusedPanelId,
    currentProject: "proj1",
    projectGrids: {},
    projectFocused: {},
    dock: { visible: false, height: 30 },
    projectDock: {},
  });
  useWindowStore.setState({ windows: {}, restored: true });
}

beforeEach(() => {
  localStorageStub.clear();
  useWindowStore.setState({ windows: {}, restored: true });
});

describe("popOutTab", () => {
  it("creates an off-grid window panel holding the tab, and leaves the grid untouched", () => {
    seedStore(
      [makePanel("panel-A", [{ id: "terminal:1", type: "terminal" }, { id: "editor:/a.ts", type: "editor" }])],
      [["panel-A"]],
      "panel-A",
    );

    const windowId = usePanelStore.getState().popOutTab("terminal:1", "panel-A");

    expect(windowId).toBeTruthy();
    const state = usePanelStore.getState();
    const pid = windowPanelId(windowId!);
    expect(state.panels[pid]?.tabs.map((t) => t.id)).toEqual(["terminal:1"]);
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).toEqual(["editor:/a.ts"]);
    expect(state.grid.flat().some(isWindowPanelId)).toBe(false);
    expect(state.grid).toEqual([["panel-A"]]);
  });

  it("opens a tab-host window carrying the origin panel and the tab title", () => {
    seedStore([makePanel("panel-A", [{ id: "chat:x/1", type: "chat" }])], [["panel-A"]], "panel-A");

    const windowId = usePanelStore.getState().popOutTab("chat:x/1", "panel-A")!;

    const win = useWindowStore.getState().windows[windowId];
    expect(win?.kind).toBe("tab-host");
    expect(win?.payload?.originPanelId).toBe("panel-A");
    expect(win?.payload?.title).toBe("chat:x/1");
  });

  it("keeps focus on the source grid panel, so the next openTab lands in the grid", () => {
    seedStore(
      [makePanel("panel-A", [{ id: "terminal:1", type: "terminal" }, { id: "editor:/a.ts", type: "editor" }])],
      [["panel-A"]],
      "panel-A",
    );

    usePanelStore.getState().popOutTab("terminal:1", "panel-A");
    expect(usePanelStore.getState().focusedPanelId).toBe("panel-A");

    usePanelStore.getState().openTab({ type: "editor", title: "b.ts", projectId: "proj1", closable: true, metadata: { filePath: "/b.ts" } });

    const state = usePanelStore.getState();
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).toContain("editor:/b.ts");
    expect(isWindowPanelId(state.focusedPanelId)).toBe(false);
    expect(state.grid.flat()).toContain(state.focusedPanelId);
  });

  it("auto-closes an emptied source panel and moves focus to a surviving grid panel", () => {
    seedStore(
      [
        makePanel("panel-A", [{ id: "terminal:1", type: "terminal" }]),
        makePanel("panel-B", [{ id: "editor:/b.ts", type: "editor" }]),
      ],
      [["panel-A", "panel-B"]],
      "panel-A",
    );

    const windowId = usePanelStore.getState().popOutTab("terminal:1", "panel-A")!;

    const state = usePanelStore.getState();
    expect(state.panels["panel-A"]).toBeUndefined();
    expect(state.grid.flat()).toEqual(["panel-B"]);
    expect(state.focusedPanelId).toBe("panel-B");
    expect(state.panels[windowPanelId(windowId)]?.tabs).toHaveLength(1);
  });

  it("keeps the last grid panel alive even when its only tab is popped out", () => {
    seedStore([makePanel("panel-A", [{ id: "terminal:1", type: "terminal" }])], [["panel-A"]], "panel-A");

    usePanelStore.getState().popOutTab("terminal:1", "panel-A");

    const state = usePanelStore.getState();
    expect(state.panels["panel-A"]?.tabs).toHaveLength(0);
    expect(state.grid).toEqual([["panel-A"]]);
    expect(state.focusedPanelId).toBe("panel-A");
  });

  it("rejects a system-monitor tab without opening a window or touching the panels", () => {
    seedStore([makePanel("panel-A", [{ id: "system-monitor:1", type: "system-monitor" }])], [["panel-A"]], "panel-A");
    const before = usePanelStore.getState().panels;

    const result = usePanelStore.getState().popOutTab("system-monitor:1", "panel-A");

    expect(result).toBeNull();
    expect(useWindowStore.getState().windows).toEqual({});
    expect(usePanelStore.getState().panels).toBe(before);
  });

  it("rejects an unknown tab id", () => {
    seedStore([makePanel("panel-A", [{ id: "terminal:1", type: "terminal" }])], [["panel-A"]], "panel-A");

    expect(usePanelStore.getState().popOutTab("terminal:404", "panel-A")).toBeNull();
    expect(useWindowStore.getState().windows).toEqual({});
  });

  it("rejects at the shared window cap and mutates nothing", () => {
    seedStore(
      [makePanel("panel-A", [{ id: "terminal:1", type: "terminal" }, { id: "editor:/a.ts", type: "editor" }])],
      [["panel-A"]],
      "panel-A",
    );
    for (let i = 0; i < MAX_WINDOWS; i++) useWindowStore.getState().open("explorer");
    const panelsBefore = usePanelStore.getState().panels;
    const windowsBefore = useWindowStore.getState().windows;

    const result = usePanelStore.getState().popOutTab("terminal:1", "panel-A");

    expect(result).toBeNull();
    expect(usePanelStore.getState().panels).toBe(panelsBefore);
    expect(Object.keys(useWindowStore.getState().windows)).toEqual(Object.keys(windowsBefore));
    expect(usePanelStore.getState().panels["panel-A"]?.tabs.map((t) => t.id)).toContain("terminal:1");
  });

  it("persists the window panel so a reload can bring it back", () => {
    seedStore([makePanel("panel-A", [{ id: "terminal:1", type: "terminal" }, { id: "editor:/a.ts", type: "editor" }])], [["panel-A"]], "panel-A");

    const windowId = usePanelStore.getState().popOutTab("terminal:1", "panel-A")!;

    const raw = localStorageStub.getItem("ppm-window-panels");
    expect(raw).toBeTruthy();
    const blob = JSON.parse(raw!) as Record<string, { tabs: { id: string }[] }>;
    expect(blob[windowPanelId(windowId)]?.tabs.map((t) => t.id)).toEqual(["terminal:1"]);
  });
});
