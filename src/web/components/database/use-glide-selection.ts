import { useState, useCallback, useMemo } from "react";
import { CompactSelection, type GridSelection } from "@glideapps/glide-data-grid";
import { selectedRowIndices as rowsOfSelection } from "./grid/selection-stats";

const EMPTY_SELECTION: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
};

interface UseGlideSelectionResult {
  gridSelection: GridSelection;
  onGridSelectionChange: (newSel: GridSelection) => void;
  /** The rows the selection covers — its cell ranges and whole rows — which Delete row(s) deletes. */
  selectedRowIndices: number[];
  clearSelection: () => void;
}

/**
 * Manages controlled selection state for Glide Data Grid: DBGate's selection, where a title selects
 * its column, a row number its row, and dragging, Shift and Ctrl grow it or add to it.
 */
export function useGlideSelection(rowCount: number): UseGlideSelectionResult {
  const [gridSelection, setGridSelection] = useState<GridSelection>(EMPTY_SELECTION);

  const onGridSelectionChange = useCallback((newSel: GridSelection) => {
    setGridSelection(newSel);
  }, []);

  const selectedRowIndices = useMemo(() => rowsOfSelection(gridSelection, rowCount), [gridSelection, rowCount]);

  const clearSelection = useCallback(() => {
    setGridSelection(EMPTY_SELECTION);
  }, []);

  return { gridSelection, onGridSelectionChange, selectedRowIndices, clearSelection };
}
