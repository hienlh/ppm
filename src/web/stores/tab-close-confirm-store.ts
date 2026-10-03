/**
 * Closing a tab that holds work nothing else keeps — a table changed on its Structure tab and not
 * saved yet, SQL typed in a Query tab, rows changed in a grid and not saved — asks first, as
 * DBGate's "Confirm close tabs" does: one question for every such tab a close takes with it, and
 * Cancel closes none of them. The closes a person asks for (a tab's ×, its menu, Close others,
 * Close to the right) go through `closeTabsAsked`; a close the app makes by itself — the file
 * behind a tab was deleted — does not ask.
 */
import { create } from "zustand";
import { isDbTabDirty } from "@/lib/db-tabs";
import { usePanelStore } from "./panel-store";
import { unsavedGridRows } from "./unsaved-grid-rows-store";
import type { Tab } from "./tab-store";

/** The tab would take unsaved work with it. */
export function losesWorkOnClose(tab: Pick<Tab, "id" | "type" | "metadata">): boolean {
  return isDbTabDirty(tab.type, tab.metadata) || unsavedGridRows(tab.id) > 0;
}

interface PendingClose {
  tabs: Tab[];
  resolve: (close: boolean) => void;
}

export const useTabCloseConfirm = create<{ pending: PendingClose | null }>(() => ({ pending: null }));

function askToClose(tabs: Tab[]): Promise<boolean> {
  return new Promise((resolve) => {
    // A second question replaces the first, which is then answered no: nothing it covered closes.
    useTabCloseConfirm.getState().pending?.resolve(false);
    useTabCloseConfirm.setState({ pending: { tabs, resolve } });
  });
}

/** The dialog's answer. */
export function settleTabClose(close: boolean): void {
  const pending = useTabCloseConfirm.getState().pending;
  if (!pending) return;
  useTabCloseConfirm.setState({ pending: null });
  pending.resolve(close);
}

/**
 * Closes the tabs `ids` names — in `panelId`, or wherever each one is — once the person agreed to
 * lose what any of them holds. True when they closed.
 */
export async function closeTabsAsked(ids: readonly string[], panelId?: string): Promise<boolean> {
  const find = (id: string) => {
    const store = usePanelStore.getState();
    const panel = panelId ? store.panels[panelId] : store.getPanelForTab(id);
    return panel?.tabs.find((t) => t.id === id);
  };
  const tabs = ids.map(find).filter((t): t is Tab => t !== undefined);
  const losing = tabs.filter(losesWorkOnClose);
  if (losing.length > 0 && !(await askToClose(losing))) return false;
  // Looked up again: the tabs may have moved or closed while the question was open.
  for (const t of tabs) if (find(t.id)) usePanelStore.getState().closeTab(t.id, panelId);
  return true;
}
