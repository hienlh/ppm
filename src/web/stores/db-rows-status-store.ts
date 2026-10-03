/**
 * A table tab's "Rows: N", for the status bar. DBGate puts a lone grid's row count in its status bar
 * (`StatusBarTabItem`) rather than over the grid, where a box covers the cells of the last row read
 * — a new row being typed in among them. Each table tab files its count under its tab id while it
 * is mounted; the bar shows the one whose tab is in front of the focused panel.
 */
import { create } from "zustand";
import type { RowCountView } from "@/components/database/glide-grid-types";

export interface DbRowsStatus {
  rowCount: RowCountView;
  /** Counts every row, with no short time limit: offered once the background count gave up. */
  onCountExactly?: () => void;
}

interface DbRowsStatusStore {
  byTab: Readonly<Record<string, DbRowsStatus>>;
  /** Files a tab's count, or takes it back with null. */
  file: (tabId: string, status: DbRowsStatus | null) => void;
}

export const useDbRowsStatusStore = create<DbRowsStatusStore>()((set) => ({
  byTab: {},
  file: (tabId, status) => set((s) => {
    if (status) return { byTab: { ...s.byTab, [tabId]: status } };
    if (!Object.hasOwn(s.byTab, tabId)) return s;
    const byTab = { ...s.byTab };
    delete byTab[tabId];
    return { byTab };
  }),
}));
