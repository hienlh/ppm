/**
 * Dock position + expanded state tests (Bottom Nav v2 / generalized dock).
 *
 * Design:
 *   - dock.position lives in settings-store as a PER-USER pref (like sidebarWidth),
 *     persisted to localStorage + pushed to server. Default "bottom".
 *   - dockExpanded (maximize) is a SESSION-ONLY panel-store field: toggles in memory,
 *     never persisted, does not touch dock.visible / dock.height.
 *
 * These invariants keep the existing per-project dock persistence (visible/height)
 * untouched — see dock-state.test.ts and panel-persist-dock-migration.test.ts.
 */
import { describe, it, expect, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// In-memory localStorage stub — must be set before store import
// ---------------------------------------------------------------------------
const memStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (key: string) => memStore[key] ?? null,
  setItem: (key: string, value: string) => { memStore[key] = value; },
  removeItem: (key: string) => { delete memStore[key]; },
  clear: () => { for (const k of Object.keys(memStore)) delete memStore[k]; },
};
(globalThis as unknown as { localStorage: typeof localStorageStub }).localStorage = localStorageStub;

// fetch stub — settings-store pushes UI prefs to the server (debounced); swallow it.
(globalThis as unknown as { fetch: () => Promise<Response> }).fetch = () =>
  Promise.resolve(new Response("{}", { status: 200 }));

// Import AFTER stubbing localStorage
import { useSettingsStore } from "../../../src/web/stores/settings-store";
import { usePanelStore } from "../../../src/web/stores/panel-store";

// ---------------------------------------------------------------------------
// settings-store: dock.position (per-user pref)
// ---------------------------------------------------------------------------
describe("settings-store — dockPosition", () => {
  beforeEach(() => {
    localStorageStub.clear();
    useSettingsStore.setState({ dockPosition: "bottom" });
  });

  it("defaults to 'bottom'", () => {
    expect(useSettingsStore.getState().dockPosition).toBe("bottom");
  });

  it("setDockPosition('right') updates store state", () => {
    useSettingsStore.getState().setDockPosition("right");
    expect(useSettingsStore.getState().dockPosition).toBe("right");
  });

  it("setDockPosition persists to localStorage (ppm-settings)", () => {
    useSettingsStore.getState().setDockPosition("left");
    const raw = localStorageStub.getItem("ppm-settings");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).dockPosition).toBe("left");
  });

  it("accepts all three positions", () => {
    for (const pos of ["left", "bottom", "right"] as const) {
      useSettingsStore.getState().setDockPosition(pos);
      expect(useSettingsStore.getState().dockPosition).toBe(pos);
    }
  });
});

// ---------------------------------------------------------------------------
// panel-store: dockExpanded (session-only)
// ---------------------------------------------------------------------------
describe("panel-store — dockExpanded (session-only)", () => {
  beforeEach(() => {
    localStorageStub.clear();
    usePanelStore.setState({
      dock: { visible: false, height: 30 },
      dockExpanded: false,
      projectDock: {},
      currentProject: "test-project",
    });
  });

  it("defaults to false", () => {
    expect(usePanelStore.getState().dockExpanded).toBe(false);
  });

  it("toggleDockExpanded() flips false → true", () => {
    usePanelStore.getState().toggleDockExpanded();
    expect(usePanelStore.getState().dockExpanded).toBe(true);
  });

  it("toggleDockExpanded() flips true → false", () => {
    usePanelStore.setState({ dockExpanded: true });
    usePanelStore.getState().toggleDockExpanded();
    expect(usePanelStore.getState().dockExpanded).toBe(false);
  });

  it("toggleDockExpanded() does not touch dock.visible or dock.height", () => {
    usePanelStore.setState({ dock: { visible: true, height: 42 }, dockExpanded: false });
    usePanelStore.getState().toggleDockExpanded();
    const { dock } = usePanelStore.getState();
    expect(dock.visible).toBe(true);
    expect(dock.height).toBe(42);
  });

  it("dockExpanded is NOT persisted (localStorage dock blob has no 'expanded' key)", () => {
    usePanelStore.getState().toggleDockExpanded();
    // Trigger a dock persist via a real dock mutation
    usePanelStore.getState().setDockHeight(50);
    const raw = localStorageStub.getItem("ppm-panels-test-project");
    expect(raw).not.toBeNull();
    const blob = JSON.parse(raw!);
    expect(blob.dock).toBeDefined();
    expect("expanded" in blob.dock).toBe(false);
  });
});
