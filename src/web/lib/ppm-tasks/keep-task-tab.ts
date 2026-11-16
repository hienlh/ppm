/**
 * Keeps a task's preview tab (an edit was made in it, or the tab was double-clicked). Its own
 * module, with only the panel store behind it, so the tab bar can import it without pulling in
 * the task views.
 */
import { usePanelStore } from "@/stores/panel-store";
import { isPreviewTab, keptMetadata, taskIdOfTab } from "./task-tab-preview";

/** A no-op when the task's tab is already kept, or not open. */
export function keepTaskTab(taskId: string): void {
  const store = usePanelStore.getState();
  for (const p of Object.values(store.panels)) {
    const tab = p.tabs.find((t) => taskIdOfTab(t) === taskId);
    if (tab && isPreviewTab(tab)) store.updateTab(tab.id, { metadata: keptMetadata(tab.metadata) });
  }
}
