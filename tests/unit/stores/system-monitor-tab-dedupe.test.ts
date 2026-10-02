/**
 * There is one machine to watch, so opening the System Monitor again on a phone has to land
 * on the tab already open — what the desktop window does. The tab used to get a random id,
 * so every open from the palette added another tab.
 */
import { afterAll, afterEach, expect, it } from "bun:test";
import { installGlobal, uninstallDom } from "../../helpers/react-dom.tsx";

// In-memory localStorage, so the store's persist() writes nowhere another file reads.
const memStore: Record<string, string> = {};
installGlobal("localStorage", {
  getItem: (key: string) => memStore[key] ?? null,
  setItem: (key: string, value: string) => { memStore[key] = value; },
  removeItem: (key: string) => { delete memStore[key]; },
  clear: () => { for (const k of Object.keys(memStore)) delete memStore[k]; },
});
afterAll(uninstallDom);

const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { DOCK_PANEL_ID } = await import("../../../src/web/stores/panel-utils");
const { resolveOpenSystemMonitorAction } = await import("../../../src/web/components/system/resolve-open-system-monitor-action");

// The store's `isMobile()` reads `window.innerWidth`. The DOM is shared by every test file in
// the process, so the real width goes back afterwards.
const realWidth = window.innerWidth;
const setWidth = (value: number) => Object.defineProperty(window, "innerWidth", { value, configurable: true });
afterEach(() => setWidth(realWidth));

it("a second System Monitor on a phone focuses the first", () => {
  setWidth(390);
  const empty = (id: string) => ({ id, tabs: [], activeTabId: null, tabHistory: [] });
  usePanelStore.setState({
    panels: { "panel-A": empty("panel-A"), [DOCK_PANEL_ID]: empty(DOCK_PANEL_ID) },
    grid: [["panel-A"]],
    focusedPanelId: "panel-A",
    currentProject: "proj1",
    projectGrids: {},
    projectFocused: {},
    dock: { visible: false, height: 30 },
    projectDock: {},
  });
  const action = resolveOpenSystemMonitorAction(true, null);
  if (action.kind !== "tab") throw new Error(`a phone opens a tab, got ${action.kind}`);

  const first = usePanelStore.getState().openTab(action.tab);
  const second = usePanelStore.getState().openTab(action.tab);

  expect(second).toBe(first);
  expect(usePanelStore.getState().panels["panel-A"]!.tabs.map((t) => t.type)).toEqual(["system-monitor"]);
});
