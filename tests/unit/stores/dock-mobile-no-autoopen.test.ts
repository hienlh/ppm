/**
 * Mobile renders the dock as a bottom sheet over the whole viewport, so a persisted
 * "visible" dock must not restore itself on load — it would cover the workspace before
 * the user ever asked for a terminal. The sheet opens only from the nav button.
 *
 * Desktop keeps restoring the dock: there it is a docked panel, not an overlay.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

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
import { collapseRestoredDockOnMobile } from "../../../src/web/stores/dock-actions";

const PROJECT = "proj-mobile";

/** Persist a layout whose dock was left open, as another session would have. */
function seedPersistedLayoutWithVisibleDock() {
  localStorageStub.setItem(`ppm-panels-${PROJECT}`, JSON.stringify({
    panels: {
      "panel-A": {
        id: "panel-A",
        tabs: [{ id: "editor:/foo.ts", type: "editor", title: "foo.ts", projectId: PROJECT, closable: true }],
        activeTabId: "editor:/foo.ts",
        tabHistory: ["editor:/foo.ts"],
      },
    },
    grid: [["panel-A"]],
    focusedPanelId: "panel-A",
    dock: { visible: true, height: 40 },
    dockPanel: {
      id: "__dock__",
      tabs: [{ id: "terminal:1", type: "terminal", title: "Terminal", projectId: PROJECT, closable: true }],
      activeTabId: "terminal:1",
      tabHistory: ["terminal:1"],
    },
    updatedAt: new Date().toISOString(),
  }));
}

function setViewportWidth(width: number) {
  (globalThis as unknown as { window: { innerWidth: number } }).window = { innerWidth: width };
}

describe("collapseRestoredDockOnMobile", () => {
  it("collapses a visible dock on mobile, preserving height", () => {
    expect(collapseRestoredDockOnMobile({ visible: true, height: 40 }, true)).toEqual({ visible: false, height: 40 });
  });

  it("leaves a visible dock alone on desktop", () => {
    expect(collapseRestoredDockOnMobile({ visible: true, height: 40 }, false)).toEqual({ visible: true, height: 40 });
  });

  it("is a no-op for an already-hidden dock", () => {
    const dock = { visible: false, height: 30 };
    expect(collapseRestoredDockOnMobile(dock, true)).toBe(dock);
  });
});

describe("switchProject — restoring a persisted visible dock", () => {
  beforeEach(() => {
    localStorageStub.clear();
    seedPersistedLayoutWithVisibleDock();
    // Drop in-memory snapshots so the load reads the persisted blob.
    usePanelStore.setState({ currentProject: null, projectGrids: {}, projectFocused: {}, projectDock: {} });
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("mobile: dock stays hidden, height and dock tabs are kept", () => {
    setViewportWidth(400);
    usePanelStore.getState().switchProject(PROJECT);

    const s = usePanelStore.getState();
    expect(s.dock.visible).toBe(false);
    expect(s.dock.height).toBe(40);
    // The parked terminal is still there — only the sheet is closed.
    expect(s.panels["__dock__"]?.tabs.map((t) => t.id)).toContain("terminal:1");
  });

  it("desktop: dock restores visible", () => {
    setViewportWidth(1440);
    usePanelStore.getState().switchProject(PROJECT);

    const s = usePanelStore.getState();
    expect(s.dock.visible).toBe(true);
    expect(s.dock.height).toBe(40);
  });
});
