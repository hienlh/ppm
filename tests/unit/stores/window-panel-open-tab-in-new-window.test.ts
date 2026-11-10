/**
 * Opening a tab straight into a new floating window, the way the Assistant shows another
 * project's manager chat: the tab never passes through a grid, so another project's keep-alive
 * grid holding the same session is left exactly as it was, the tab id stays unique, closing the
 * window closes the tab, and a refused window (the cap, a phone) creates nothing.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach } from "bun:test";
import { installGlobal, uninstallDom } from "../../helpers/react-dom.tsx";

const memStore: Record<string, string> = {};
installGlobal("localStorage", {
  getItem: (key: string) => memStore[key] ?? null,
  setItem: (key: string, value: string) => { memStore[key] = value; },
  removeItem: (key: string) => { delete memStore[key]; },
  clear: () => { for (const k of Object.keys(memStore)) delete memStore[k]; },
});
afterAll(uninstallDom);

import { usePanelStore } from "../../../src/web/stores/panel-store";
import { useWindowStore } from "../../../src/web/components/floating-window/window-store";
import { MAX_WINDOWS } from "../../../src/web/components/floating-window/window-geometry";
import { closeWindow } from "../../../src/web/components/floating-window/close-window";
import { DOCK_PANEL_ID, windowPanelId, type Panel } from "../../../src/web/stores/panel-utils";

const managerTab = {
  type: "chat" as const, title: "nxsys · manager", projectId: null, closable: true,
  metadata: { projectName: "nxsys", sessionId: "mgr-1", providerId: "claude", managerWindow: true },
};

// Project "nxsys" has the same session open in its hidden keep-alive grid.
const hiddenGrid: Panel = {
  id: "nx-left", activeTabId: "chat:claude/mgr-1", tabHistory: ["chat:claude/mgr-1"],
  tabs: [{ id: "chat:claude/mgr-1", type: "chat", title: "Manager", projectId: "nxsys", closable: true, metadata: { sessionId: "mgr-1", providerId: "claude" } }],
};
const ppmGrid: Panel = { id: "ppm-left", tabs: [], activeTabId: null, tabHistory: [] };

// The store is shared with every other test file in the process: put its device check back.
const realIsMobile = usePanelStore.getState().isMobile;
afterEach(() => {
  usePanelStore.setState({ isMobile: realIsMobile });
  useWindowStore.setState({ windows: {} });
});

beforeEach(() => {
  for (const k of Object.keys(memStore)) delete memStore[k];
  usePanelStore.setState({
    panels: { "ppm-left": ppmGrid, "nx-left": hiddenGrid, [DOCK_PANEL_ID]: { id: DOCK_PANEL_ID, tabs: [], activeTabId: null, tabHistory: [] } },
    grid: [["ppm-left"]], focusedPanelId: "ppm-left", currentProject: "ppm",
    projectGrids: { nxsys: [["nx-left"]] }, projectFocused: {}, dock: { visible: false, height: 30 }, projectDock: {},
    isMobile: () => false,
  });
  useWindowStore.setState({ windows: {}, restored: true });
});

describe("openTabInNewWindow", () => {
  it("places the tab in a new window panel, leaving every grid untouched", () => {
    const opened = usePanelStore.getState().openTabInNewWindow(managerTab)!;
    expect(opened).not.toBeNull();
    const s = usePanelStore.getState();
    const panel = s.panels[windowPanelId(opened.windowId)]!;
    expect(panel.tabs.map((t) => t.id)).toEqual([opened.tabId]);
    expect(panel.tabs[0]!.projectId).toBeNull();
    expect(panel.tabs[0]!.metadata?.projectName).toBe("nxsys");
    // The session already has a tab id in nxsys's grid: this one may not take it.
    expect(opened.tabId).not.toBe("chat:claude/mgr-1");
    expect(s.panels["nx-left"]).toBe(hiddenGrid);
    expect(s.panels["ppm-left"]).toBe(ppmGrid);
    expect(s.grid).toEqual([["ppm-left"]]);
    expect(s.focusedPanelId).toBe("ppm-left");
    expect(useWindowStore.getState().windows[opened.windowId]?.payload?.closeTabsOnClose).toBe(true);
  });

  it("closing the window closes the tab rather than handing it to a grid", () => {
    const opened = usePanelStore.getState().openTabInNewWindow(managerTab)!;
    closeWindow(opened.windowId);
    const s = usePanelStore.getState();
    expect(s.panels[windowPanelId(opened.windowId)]).toBeUndefined();
    expect(s.panels["ppm-left"]!.tabs).toEqual([]);
    expect(useWindowStore.getState().windows[opened.windowId]).toBeUndefined();
  });

  it("creates nothing at the window cap or on a phone", () => {
    for (let i = 0; i < MAX_WINDOWS; i++) useWindowStore.getState().open("logs");
    const before = usePanelStore.getState().panels;
    expect(usePanelStore.getState().openTabInNewWindow(managerTab)).toBeNull();
    expect(usePanelStore.getState().panels).toBe(before);
    useWindowStore.setState({ windows: {} });
    usePanelStore.setState({ isMobile: () => true });
    expect(usePanelStore.getState().openTabInNewWindow(managerTab)).toBeNull();
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(0);
  });
});
