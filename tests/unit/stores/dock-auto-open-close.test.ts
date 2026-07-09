/**
 * Dock UX: never show an empty dock.
 *  - Opening the dock (toggleDock) when it has no terminals auto-opens one.
 *  - Closing the last dock terminal auto-hides the dock.
 */
import { describe, it, expect, beforeEach } from "bun:test";

const memStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (k: string) => memStore[k] ?? null,
  setItem: (k: string, v: string) => { memStore[k] = v; },
  removeItem: (k: string) => { delete memStore[k]; },
  clear: () => { for (const k of Object.keys(memStore)) delete memStore[k]; },
};
(globalThis as unknown as { localStorage: typeof localStorageStub }).localStorage = localStorageStub;

import { usePanelStore } from "../../../src/web/stores/panel-store";
import { DOCK_PANEL_ID } from "../../../src/web/stores/panel-utils";

describe("dock auto open/close (no empty state)", () => {
  beforeEach(() => {
    localStorageStub.clear();
    // Reset the singleton store: empty __dock__, dock hidden, known active project.
    usePanelStore.getState().switchProject("proj-x");
    usePanelStore.setState((s) => ({
      currentProject: "proj-x",
      dock: { visible: false, height: 30 },
      panels: { ...s.panels, [DOCK_PANEL_ID]: { id: DOCK_PANEL_ID, tabs: [], activeTabId: null, tabHistory: [] } },
    }));
  });

  it("toggleDock on an empty dock opens the dock AND auto-creates a terminal", () => {
    usePanelStore.getState().toggleDock();
    const s = usePanelStore.getState();
    expect(s.dock.visible).toBe(true);
    const dockTabs = s.panels[DOCK_PANEL_ID]?.tabs ?? [];
    expect(dockTabs.length).toBe(1);
    expect(dockTabs[0]!.type).toBe("terminal");
  });

  it("toggleDock does NOT add a second terminal when the dock already has one", () => {
    usePanelStore.getState().openInDock({ type: "terminal", title: "Terminal", projectId: "proj-x", closable: true, metadata: {} });
    // dock is now visible with 1 terminal; hide then re-open
    usePanelStore.getState().toggleDock(); // hide
    usePanelStore.getState().toggleDock(); // show — must NOT auto-add another
    const dockTabs = usePanelStore.getState().panels[DOCK_PANEL_ID]?.tabs ?? [];
    expect(dockTabs.length).toBe(1);
  });

  it("closing the last dock terminal auto-hides the dock (panel kept, empty)", () => {
    const id = usePanelStore.getState().openInDock({ type: "terminal", title: "Terminal", projectId: "proj-x", closable: true, metadata: {} });
    expect(usePanelStore.getState().dock.visible).toBe(true);

    usePanelStore.getState().closeTab(id, DOCK_PANEL_ID);
    const s = usePanelStore.getState();
    expect(s.dock.visible).toBe(false);
    expect(s.panels[DOCK_PANEL_ID]).toBeDefined();
    expect(s.panels[DOCK_PANEL_ID]?.tabs.length).toBe(0);
  });

  it("closing a non-last dock terminal keeps the dock open", () => {
    const id1 = usePanelStore.getState().openInDock({ type: "terminal", title: "T1", projectId: "proj-x", closable: true, metadata: { terminalIndex: 1 } });
    usePanelStore.getState().openInDock({ type: "terminal", title: "T2", projectId: "proj-x", closable: true, metadata: { terminalIndex: 2 } });
    usePanelStore.getState().closeTab(id1, DOCK_PANEL_ID);
    expect(usePanelStore.getState().dock.visible).toBe(true);
  });
});
