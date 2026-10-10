/**
 * A project layout written by another device can name a tab this device keeps in a floating
 * window — a phone has no windows, so it keeps the PPM Assistant as a grid tab, and the server
 * hands that layout to the desktop, whose Assistant lives in a window. Loading it must not put
 * the same tab id in the grid as well: two panels holding one tab mount one body, and the other
 * renders as a blank window.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { installGlobal, uninstallDom } from "../../helpers/react-dom.tsx";

const memStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (key: string) => memStore[key] ?? null,
  setItem: (key: string, value: string) => { memStore[key] = value; },
  removeItem: (key: string) => { delete memStore[key]; },
  clear: () => { for (const k of Object.keys(memStore)) delete memStore[k]; },
};
installGlobal("localStorage", localStorageStub);
afterAll(uninstallDom);

import { usePanelStore } from "../../../src/web/stores/panel-store";
import { useWindowStore } from "../../../src/web/components/floating-window/window-store";
import { DOCK_PANEL_ID, windowPanelId, type Panel } from "../../../src/web/stores/panel-utils";

const PROJECT = "twin-proj";
const WIN = windowPanelId("win-twin");
const tab = (id: string, type: string, projectId: string | null) => ({ id, type: type as Panel["tabs"][number]["type"], title: id, projectId, closable: true });

beforeEach(() => {
  localStorageStub.clear();
  useWindowStore.setState({ windows: {}, restored: true });
});

describe("loading a project layout next to this device's floating windows", () => {
  it("leaves a tab a window holds out of the grid, and writes the repaired layout back", () => {
    // What the phone saved: the Assistant beside a chat, in the grid.
    memStore[`ppm-panels-${PROJECT}`] = JSON.stringify({
      panels: { "panel-g": { id: "panel-g", tabs: [tab("assistant", "assistant", null), tab("chat:claude/1", "chat", PROJECT)], activeTabId: "assistant", tabHistory: ["chat:claude/1", "assistant"] } },
      grid: [["panel-g"]],
      focusedPanelId: "panel-g",
      updatedAt: new Date().toISOString(),
    });
    // This desktop: the Assistant in its own window, already in memory (as hydration leaves it).
    usePanelStore.setState({
      currentProject: null, grid: [], focusedPanelId: "", projectGrids: {}, projectFocused: {}, projectDock: {},
      panels: {
        [WIN]: { id: WIN, tabs: [tab("assistant", "assistant", null)], activeTabId: "assistant", tabHistory: ["assistant"] },
        [DOCK_PANEL_ID]: { id: DOCK_PANEL_ID, tabs: [], activeTabId: null, tabHistory: [] },
      },
    });

    usePanelStore.getState().switchProject(PROJECT);

    const state = usePanelStore.getState();
    const grid = state.grid.flat().flatMap((id) => state.panels[id]!.tabs.map((t) => t.id));
    expect(grid).toEqual(["chat:claude/1"]);
    expect(state.panels["panel-g"]!.activeTabId).toBe("chat:claude/1");
    expect(state.panels[WIN]!.tabs.map((t) => t.id)).toEqual(["assistant"]);
    const saved = JSON.parse(memStore[`ppm-panels-${PROJECT}`]!);
    expect(saved.panels["panel-g"].tabs.map((t: { id: string }) => t.id)).toEqual(["chat:claude/1"]);
  });

  it("keeps the tab in the grid when no window holds it", () => {
    memStore[`ppm-panels-${PROJECT}-2`] = JSON.stringify({
      panels: { "panel-h": { id: "panel-h", tabs: [tab("assistant", "assistant", null)], activeTabId: "assistant", tabHistory: ["assistant"] } },
      grid: [["panel-h"]],
      focusedPanelId: "panel-h",
      updatedAt: new Date().toISOString(),
    });
    usePanelStore.setState({
      currentProject: null, grid: [], focusedPanelId: "", projectGrids: {}, projectFocused: {}, projectDock: {},
      panels: { [DOCK_PANEL_ID]: { id: DOCK_PANEL_ID, tabs: [], activeTabId: null, tabHistory: [] } },
    });

    usePanelStore.getState().switchProject(`${PROJECT}-2`);

    expect(usePanelStore.getState().panels["panel-h"]!.tabs.map((t) => t.id)).toEqual(["assistant"]);
  });
});
