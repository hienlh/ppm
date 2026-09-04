/**
 * Pure reconciliation between the off-grid window panels and the windows that are
 * actually alive.
 *
 * The two halves are persisted separately (windows are global geometry, panels hold live
 * tabs), so a reload can land on either side alone: a panel whose window blob was dropped
 * would hide its tabs with no way to reach them, and a window whose panel is gone would
 * float empty. Mobile is the same case by construction — the window layer renders
 * nothing there, so no window is live and every detached tab comes back to the grid.
 */
import type { Panel } from "./panel-utils";
import { isWindowPanelId, windowIdFromPanelId, windowPanelId } from "./panel-utils";
import type { Tab } from "./tab-store";

export interface ReconcileInput {
  panels: Record<string, Panel>;
  grid: string[][];
  focusedPanelId: string;
  /** Ids of the tab-host windows currently in the window store. */
  liveWindowIds: readonly string[];
}

export interface ReconcileResult {
  panels: Record<string, Panel>;
  focusedPanelId: string;
  /** Tab-host windows with no panel behind them — the caller closes these. */
  windowIdsToClose: string[];
  /** True when `panels`/`focusedPanelId` differ from the input and must be committed. */
  changed: boolean;
}

/** Append tabs to a panel without disturbing which tab the user was last looking at. */
function appendTabs(target: Panel, tabs: Tab[]): Panel {
  const known = new Set(target.tabs.map((t) => t.id));
  const incoming = tabs.filter((t) => !known.has(t.id));
  if (incoming.length === 0) return target;
  const merged = [...target.tabs, ...incoming];
  return {
    ...target,
    tabs: merged,
    tabHistory: [...target.tabHistory, ...incoming.map((t) => t.id)],
    activeTabId: target.activeTabId ?? merged[merged.length - 1]!.id,
  };
}

export function reconcileTabHostWindows(input: ReconcileInput): ReconcileResult {
  const { grid, liveWindowIds } = input;
  const live = new Set(liveWindowIds);
  const flat = grid.flat();

  const panels = { ...input.panels };
  let focusedPanelId = input.focusedPanelId;
  let changed = false;

  // Panels whose window is gone: move the tabs back into the grid and drop the panel.
  // With no grid panel to receive them the panel is left untouched — losing the tabs
  // would be worse than a panel that reconciles on the next load.
  const target = flat.includes(focusedPanelId) ? focusedPanelId : flat[0];
  for (const [panelId, panel] of Object.entries(input.panels)) {
    if (!isWindowPanelId(panelId)) continue;
    const windowId = windowIdFromPanelId(panelId);
    if (windowId && live.has(windowId)) continue;
    if (!target) continue;
    const receiver = panels[target];
    if (!receiver) continue;
    panels[target] = appendTabs(receiver, panel.tabs);
    delete panels[panelId];
    changed = true;
  }

  // Windows with no panel: nothing can ever render in them.
  const windowIdsToClose = liveWindowIds.filter((id) => !panels[windowPanelId(id)]);

  // Focus must sit on a grid panel, or the next tab opened with no explicit panel lands
  // off-grid (inside a window, or nowhere at all once its panel is deleted).
  if (!flat.includes(focusedPanelId)) {
    const fallback = flat[0];
    if (fallback) {
      focusedPanelId = fallback;
      changed = true;
    }
  }

  return { panels, focusedPanelId, windowIdsToClose, changed };
}
