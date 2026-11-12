/**
 * The tab menu's Pin and bulk closes, run on the focused panel's active tab — for the command
 * palette and the customizable shortcuts, which have no tab of their own to start from.
 */
import { bulkCloseIds, type BulkClose } from "@/lib/tab-pins";
import { usePanelStore } from "@/stores/panel-store";
import { visibleTabs } from "@/stores/panel-utils";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { closeTabsAsked, tabHoldsUnsavedWork } from "@/stores/tab-close-confirm-store";

function focusedTabs() {
  const store = usePanelStore.getState();
  const panel = store.panels[store.focusedPanelId];
  if (!panel) return null;
  const tabs = visibleTabs(panel.tabs, useProjectStore.getState().activeProject?.name ?? null, useSettingsStore.getState().minimalMode);
  return { panelId: panel.id, tabs, active: tabs.find((t) => t.id === panel.activeTabId) ?? null };
}

/** Pins the active tab, or unpins it. */
export function togglePinActiveTab(): void {
  const active = focusedTabs()?.active;
  if (active) usePanelStore.getState().setTabPinned(active.id, !active.pinned);
}

/** Close Saved / Close All (or Others, Right) from the active tab of the focused panel. */
export function bulkCloseInFocusedPanel(kind: BulkClose): void {
  const found = focusedTabs();
  if (!found) return;
  const anchor = found.active?.id ?? "";
  void closeTabsAsked(bulkCloseIds(found.tabs, anchor, kind, tabHoldsUnsavedWork), found.panelId);
}
