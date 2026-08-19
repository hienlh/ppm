import { usePanelStore } from "@/stores/panel-store";

/**
 * Decides whether a tab should act on a window-level keyboard shortcut.
 *
 * Every tab stays mounted: tab-pool reparents them and hides inactive ones with
 * `display: none`, and a split grid can show several panels at once. A global
 * shortcut must therefore resolve to exactly one tab — the active tab of the
 * focused panel. Checking visibility alone would match every pane in a split,
 * so two open chats would both react to a single key press.
 *
 * Pass any node that lives inside the claiming tab.
 */
export function ownsGlobalShortcut(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  const tabId = el.closest<HTMLElement>("[data-tab-pool-id]")?.dataset.tabPoolId;
  // Not rendered through the tab pool (dialogs, previews) — visibility is enough.
  if (!tabId) return el.offsetParent !== null;
  const { panels, focusedPanelId } = usePanelStore.getState();
  return panels[focusedPanelId]?.activeTabId === tabId;
}
