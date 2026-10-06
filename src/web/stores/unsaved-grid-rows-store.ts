/**
 * Rows a database tab's grid has changed and not saved, by tab id. The changes live only in the
 * mounted grid — nothing else keeps them, and they go with the tab — so the tab shows DBGate's
 * unsaved dot while there are any, and closing it asks first (`tab-close-confirm-store.ts`).
 *
 * A tab can hold two grids — a table and the reference shown under it — each counted under its
 * own slot (`<tab id>\0<slot>`); the tab's count is theirs added up (`tabUnsavedRows`).
 */
import { create } from "zustand";

export const useUnsavedGridRows = create<Readonly<Record<string, number>>>(() => ({}));

const slotKey = (tabId: string, slot?: string) => (slot ? `${tabId}\u0000${slot}` : tabId);

/** What the grid in tab `tabId` (and `slot`, for a second grid there) would write now; 0 once it holds nothing, or has gone. */
export function setUnsavedGridRows(tabId: string, rows: number, slot?: string): void {
  const key = slotKey(tabId, slot);
  const now = useUnsavedGridRows.getState();
  if ((now[key] ?? 0) === rows) return;
  const next = { ...now };
  if (rows > 0) next[key] = rows;
  else delete next[key];
  useUnsavedGridRows.setState(next, true);
}

/** Every grid of the tab, added up. */
export function tabUnsavedRows(state: Readonly<Record<string, number>>, tabId: string): number {
  let rows = 0;
  for (const [key, count] of Object.entries(state)) {
    if (key === tabId || key.startsWith(`${tabId}\u0000`)) rows += count;
  }
  return rows;
}

export function unsavedGridRows(tabId: string): number {
  return tabUnsavedRows(useUnsavedGridRows.getState(), tabId);
}

/** One grid of the tab alone: the second one's, under its `slot`. */
export function slotUnsavedRows(tabId: string, slot?: string): number {
  return useUnsavedGridRows.getState()[slotKey(tabId, slot)] ?? 0;
}
