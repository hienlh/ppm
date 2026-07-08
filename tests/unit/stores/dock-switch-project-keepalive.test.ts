/**
 * Regression test: switching to a not-yet-loaded project (localStorage-load
 * branch of switchProject) must NOT drop another project's live dock terminals
 * from the shared __dock__ panel. Dropping them would unmount the xterm node
 * (TabPool keep-alive) and lose the PTY — violating "switch project: dock
 * terminal stays alive".
 */
import { describe, it, expect, beforeEach } from "bun:test";

// Minimal in-memory localStorage stub — must be set before store import.
const memStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (key: string) => memStore[key] ?? null,
  setItem: (key: string, value: string) => { memStore[key] = value; },
  removeItem: (key: string) => { delete memStore[key]; },
  clear: () => { for (const k of Object.keys(memStore)) delete memStore[k]; },
};
(globalThis as unknown as { localStorage: typeof localStorageStub }).localStorage = localStorageStub;

import { usePanelStore } from "../../../src/web/stores/panel-store";
import { DOCK_PANEL_ID, savePanelLayout, createDockPanel } from "../../../src/web/stores/panel-utils";
import type { Panel } from "../../../src/web/stores/panel-utils";

function gridPanel(id: string, projectId: string): Panel {
  return {
    id,
    tabs: [{ id: `editor:${projectId}`, type: "editor", title: "f", projectId, closable: true }],
    activeTabId: `editor:${projectId}`,
    tabHistory: [`editor:${projectId}`],
  };
}

describe("switchProject — cross-project dock keep-alive", () => {
  beforeEach(() => { localStorageStub.clear(); });

  it("keeps project A's live dock terminal when switching to a not-yet-loaded project B", () => {
    // Persist a layout for B (with its own grid panel + empty dock) so the
    // switchProject localStorage-load branch is taken (loaded.panels non-empty).
    savePanelLayout("projB", {
      panels: { "panel-B": gridPanel("panel-B", "projB") },
      grid: [["panel-B"]],
      focusedPanelId: "panel-B",
      dock: { visible: false, height: 30 },
      dockPanel: createDockPanel(),
    });

    // Seed store: current project A with a LIVE dock terminal in shared __dock__.
    const dock = createDockPanel();
    dock.tabs = [{ id: "terminal:1", type: "terminal", title: "Terminal", projectId: "projA", closable: true }];
    dock.activeTabId = "terminal:1";
    usePanelStore.setState({
      panels: { "panel-A": gridPanel("panel-A", "projA"), [DOCK_PANEL_ID]: dock },
      grid: [["panel-A"]],
      focusedPanelId: "panel-A",
      currentProject: "projA",
      projectGrids: { projA: [["panel-A"]] },
      projectFocused: { projA: "panel-A" },
      dock: { visible: true, height: 30 },
      projectDock: {},
    });

    usePanelStore.getState().switchProject("projB");

    const dockPanel = usePanelStore.getState().panels[DOCK_PANEL_ID];
    const dockTabs = dockPanel?.tabs.map((t) => t.id) ?? [];
    // A's live terminal must survive the switch (keep-alive).
    expect(dockTabs).toContain("terminal:1");
    // The shared dock's active tab must NOT point at A's terminal while B is
    // active (B has no dock tabs) — otherwise the slot renders A's terminal.
    expect(dockPanel?.activeTabId).toBeNull();
  });
});
