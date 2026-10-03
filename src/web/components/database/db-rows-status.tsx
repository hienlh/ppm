/**
 * The status bar's "Rows: N" for the table tab in front (`stores/db-rows-status-store.ts` says why
 * it is here and not over the grid). A count that gave up is a button: it counts every row, with no
 * short time limit.
 */
import { memo } from "react";
import { Loader2 } from "@/lib/icons";
import { usePanelStore } from "@/stores/panel-store";
import { useDbRowsStatusStore } from "@/stores/db-rows-status-store";

export const DbRowsStatus = memo(function DbRowsStatus() {
  const tabId = usePanelStore((s) => s.panels[s.focusedPanelId]?.activeTabId ?? null);
  const status = useDbRowsStatusStore((s) => (tabId ? s.byTab[tabId] : undefined));
  if (!status) return null;
  const { rowCount, onCountExactly } = status;
  if (rowCount.canCountExactly && onCountExactly) {
    return (
      <button
        type="button" onClick={onCountExactly} title={rowCount.title}
        className="shrink-0 rounded-sm px-1 underline decoration-dotted underline-offset-2 transition-colors hover:bg-primary/10 hover:text-text-primary"
      >
        {rowCount.text}
      </button>
    );
  }
  return (
    <span role="status" title={rowCount.title} className="flex shrink-0 items-center gap-1">
      {rowCount.text}
      {rowCount.counting && <Loader2 className="size-3 animate-spin" aria-label="Counting" />}
    </span>
  );
});
