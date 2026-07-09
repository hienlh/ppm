/**
 * Regression: emptying the dock (closing its last terminal) must NOT delete the
 * reserved __dock__ panel. If it does, a later re-dock (moveTab → __dock__) silently
 * no-ops (to === undefined): the terminal stays stuck in the grid while an empty dock
 * opens. Repro of the exact user-reported flow:
 *   dock empty → open terminal in editor → close it → expected to move into the dock.
 *
 * Uses the REAL openTab/closeTab flow so id-derivation + panel-registry edge cases
 * are exercised (not synthetic seed state only).
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
(globalThis as unknown as { fetch: () => Promise<Response> }).fetch = () => Promise.resolve(new Response("{}"));

import { usePanelStore } from "../../../src/web/stores/panel-store";
import { createPanel, DOCK_PANEL_ID } from "../../../src/web/stores/panel-utils";

describe("redock — empty dock, terminal opened in grid via real openTab", () => {
  beforeEach(() => {
    localStorageStub.clear();
    usePanelStore.getState().switchProject("proj-x");
  });

  it("closing the grid terminal moves it into the (empty) dock and shows the dock", () => {
    const termId = usePanelStore.getState().openTab({
      type: "terminal", title: "Terminal", projectId: "proj-x", closable: true, metadata: { projectName: "proj-x" },
    });
    const gridPid = usePanelStore.getState().grid.flat()[0]!;
    expect(usePanelStore.getState().panels[gridPid]?.tabs.map((t) => t.id)).toContain(termId);

    usePanelStore.getState().closeTab(termId, gridPid);

    const s = usePanelStore.getState();
    expect(s.dock.visible).toBe(true);
    expect(s.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id)).toContain(termId);
    expect(s.panels[gridPid]?.tabs.map((t) => t.id) ?? []).not.toContain(termId);
  });

  it("closing the LAST dock terminal keeps __dock__ alive, so a later grid re-dock still works", () => {
    // Two grid panels so gridPanelCount > 1 (this is what triggered the buggy delete).
    const a = createPanel([{ id: "editor:/a.ts", type: "editor", title: "a", projectId: "proj-x", closable: true, metadata: {} }], "editor:/a.ts");
    const b = createPanel([{ id: "editor:/b.ts", type: "editor", title: "b", projectId: "proj-x", closable: true, metadata: {} }], "editor:/b.ts");
    usePanelStore.setState((s) => ({
      panels: { ...s.panels, [a.id]: a, [b.id]: b, [DOCK_PANEL_ID]: { id: DOCK_PANEL_ID, tabs: [{ id: "terminal:9", type: "terminal", title: "Terminal", projectId: "proj-x", closable: true, metadata: {} }], activeTabId: "terminal:9", tabHistory: ["terminal:9"] } },
      grid: [[a.id, b.id]],
      focusedPanelId: a.id,
      dock: { visible: true, height: 30 },
    }));

    // Close the last dock terminal FROM the dock (real close).
    usePanelStore.getState().closeTab("terminal:9", DOCK_PANEL_ID);
    // __dock__ must survive (empty), NOT be deleted from the panels map.
    expect(usePanelStore.getState().panels[DOCK_PANEL_ID]).toBeDefined();
    expect(usePanelStore.getState().panels[DOCK_PANEL_ID]?.tabs.length).toBe(0);

    // Now open a terminal in a grid panel and close it → must re-dock (not get stuck).
    const termId = usePanelStore.getState().openTab({
      type: "terminal", title: "Terminal", projectId: "proj-x", closable: true, metadata: { projectName: "proj-x" },
    }, a.id);
    usePanelStore.getState().closeTab(termId, a.id);

    const s = usePanelStore.getState();
    expect(s.panels[DOCK_PANEL_ID]?.tabs.map((t) => t.id)).toContain(termId);
    expect(s.panels[a.id]?.tabs.map((t) => t.id) ?? []).not.toContain(termId);
    expect(s.dock.visible).toBe(true);
  });
});
