/**
 * Action factories for tabs that live in a floating window, for usePanelStore.
 *
 * Extracted to keep panel-store.ts near its size budget, mirroring dock-actions.ts.
 * This module is the ONLY writer of `__win__:` panels, which is what keeps the
 * invariant cheap to check: a window panel exists in the `panels` map and never in
 * `grid`, so no grid math (MAX_ROWS, split, column count) can ever see one.
 *
 * Second invariant, enforced after every move: `focusedPanelId` is never a window
 * panel. `moveTab` focuses its target unconditionally, and `resolvePanel()` sends the
 * next `openTab()` with no explicit panel to the focused one — leaving focus on the
 * window would silently open new tabs inside it.
 */
import type { StoreApi } from "zustand";
import type { Panel } from "./panel-utils";
import {
  createWindowPanel,
  isWindowPanelId,
  windowIdFromPanelId,
  windowPanelId,
} from "./panel-utils";
import { persistDock } from "./dock-actions";
import { loadWindowPanels, saveWindowPanels } from "./window-panel-persistence";
import { useWindowStore } from "@/components/floating-window/window-store";
import { MAX_WINDOWS } from "@/components/floating-window/window-geometry";
import type { PanelStore } from "./panel-store";

type Set = StoreApi<PanelStore>["setState"];
type Get = StoreApi<PanelStore>["getState"];

/** Tab types that never detach — the monitor already owns a window kind of its own. */
const NON_POPPABLE_TAB_TYPES = new Set(["system-monitor"]);

/**
 * A grid panel to hold focus: the preferred one when it is still in the grid, else the
 * first grid panel. Returns null only for an empty grid (nothing can be focused).
 */
function gridFocusTarget(grid: string[][], preferred?: string | null): string | null {
  const flat = grid.flat();
  if (preferred && flat.includes(preferred)) return preferred;
  return flat[0] ?? null;
}

/**
 * Persist both halves of a window-panel mutation: the global window-panel blob and the
 * active project's layout (the other side of a move is a grid panel). persistDock writes
 * the whole PanelLayout — grid panels, focus and dock — not just the dock.
 */
export function persistWindowPanelChange(get: Get): void {
  saveWindowPanels(get().panels);
  persistDock(get);
}

/**
 * Keep a floating window and its panel in lockstep after a tab left the panel: an empty
 * tab-host window has no way back to a tab, so it closes with its panel.
 */
export function syncWindowPanel(get: Get, panelId: string): void {
  saveWindowPanels(get().panels);
  const panel = get().panels[panelId];
  if (panel && panel.tabs.length > 0) return;
  const windowId = windowIdFromPanelId(panelId);
  if (windowId) useWindowStore.getState().close(windowId);
}

/**
 * Merge the persisted window panels into the flat panels map, once per session.
 *
 * They are global, so this runs on the first project load and never again — a later
 * switch must not resurrect a panel the user has since re-docked. Live panels win the
 * merge; a stale persisted twin can only be older than what is in memory.
 */
let windowPanelsHydrated = false;

export function hydrateWindowPanels(set: Set, get: Get): void {
  if (windowPanelsHydrated) return;
  windowPanelsHydrated = true;
  const loaded = loadWindowPanels();
  if (Object.keys(loaded).length === 0) return;
  set({ panels: { ...loaded, ...get().panels } });
}

/**
 * Detach a tab into a new floating window. Returns the window id, or null when the
 * request is rejected — in which case nothing is mutated and the caller reports it.
 */
export function makePopOutTab(set: Set, get: Get) {
  return function popOutTab(tabId: string, fromPanelId: string): string | null {
    // The window layer is desktop-only; on mobile a detached tab would be invisible.
    if (get().isMobile()) return null;

    const from = get().panels[fromPanelId];
    const tab = from?.tabs.find((t) => t.id === tabId);
    if (!tab || NON_POPPABLE_TAB_TYPES.has(tab.type)) return null;

    // Pre-check the cap: at the cap `open()` focuses the oldest window and returns ITS
    // id, which would attach this tab to an unrelated window.
    const windowStore = useWindowStore.getState();
    if (Object.keys(windowStore.windows).length >= MAX_WINDOWS) return null;

    const windowId = windowStore.open("tab-host", { originPanelId: fromPanelId, title: tab.title });
    const panelId = windowPanelId(windowId);
    set((s) => ({ panels: { ...s.panels, [panelId]: createWindowPanel(windowId) } }));

    get().moveTab(tabId, fromPanelId, panelId);

    const focus = gridFocusTarget(get().grid, fromPanelId);
    if (focus) set({ focusedPanelId: focus });
    persistWindowPanelChange(get);
    return windowId;
  };
}

/**
 * Send every tab of a window's panel back to the grid and drop the panel.
 *
 * Called from the window body's layout-effect cleanup, so it covers every close path
 * (titlebar ×, keyboard close, a programmatic `close()`), and is a no-op once the panel
 * is gone — closing an emptied window re-enters here and must not resurrect anything.
 */
export function makeRedockFromWindow(set: Set, get: Get) {
  return function redockFromWindow(windowId: string, originPanelId?: string | null): void {
    const panelId = windowPanelId(windowId);
    const panel = get().panels[panelId];
    if (!panel) return;

    const target = redockTarget(get(), originPanelId);
    if (target) {
      for (const tab of [...panel.tabs]) get().moveTab(tab.id, panelId, target);
    }

    set((s) => {
      const { [panelId]: _dropped, ...rest } = s.panels;
      // moveTab focused the target; re-assert it here so the resolved target wins even
      // when the last moveTab picked a different one (or none ran at all).
      const focus = gridFocusTarget(s.grid, target ?? s.focusedPanelId);
      return focus ? { panels: rest, focusedPanelId: focus } : { panels: rest };
    });
    persistWindowPanelChange(get);
  };
}

/**
 * Where a detached tab goes home to: its origin panel while that still exists, else the
 * focused panel when it is a grid panel, else the first grid panel. The origin may be the
 * dock (a terminal parked there before it was detached) but never another window.
 */
function redockTarget(state: PanelStore, originPanelId?: string | null): string | null {
  if (originPanelId && state.panels[originPanelId] && !isWindowPanelId(originPanelId)) {
    return originPanelId;
  }
  return gridFocusTarget(state.grid, state.focusedPanelId);
}

/**
 * Drop a project's tabs from every window panel, returning the panels map to commit and
 * the windows whose panel is now empty. Used when a project is reloaded: its grid panels
 * are discarded, and a window still showing one of its tabs would outlive the project.
 */
export function stripProjectFromWindowPanels(
  panels: Record<string, Panel>,
  projectName: string,
): { panels: Record<string, Panel>; windowIdsToClose: string[] } {
  const next: Record<string, Panel> = { ...panels };
  const windowIdsToClose: string[] = [];

  for (const [id, panel] of Object.entries(panels)) {
    if (!isWindowPanelId(id)) continue;
    const tabs = panel.tabs.filter((t) => t.projectId !== projectName);
    if (tabs.length === panel.tabs.length) continue;

    const windowId = windowIdFromPanelId(id);
    if (tabs.length === 0) {
      delete next[id];
      if (windowId) windowIdsToClose.push(windowId);
      continue;
    }
    const ids = new Set(tabs.map((t) => t.id));
    const tabHistory = panel.tabHistory.filter((h) => ids.has(h));
    next[id] = {
      ...panel,
      tabs,
      tabHistory,
      activeTabId:
        panel.activeTabId && ids.has(panel.activeTabId)
          ? panel.activeTabId
          : (tabHistory[tabHistory.length - 1] ?? tabs[tabs.length - 1]!.id),
    };
  }

  return { panels: next, windowIdsToClose };
}
