import { useState, useCallback, useMemo } from "react";
import { CompactSelection, type GridSelection } from "@glideapps/glide-data-grid";

const EMPTY_SELECTION: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
};

interface UseGlideSelectionResult {
  gridSelection: GridSelection;
  onGridSelectionChange: (newSel: GridSelection) => void;
  /** Array of selected row indices (derived from CompactSelection) */
  selectedRowIndices: number[];
  clearSelection: () => void;
}

/**
 * Manages controlled selection state for Glide Data Grid.
 * Provides row indices array for bulk operations (delete, export).
 */
export function useGlideSelection(): UseGlideSelectionResult {
  const [gridSelection, setGridSelection] = useState<GridSelection>(EMPTY_SELECTION);

  const onGridSelectionChange = useCallback((newSel: GridSelection) => {
    setGridSelection(newSel);
  }, []);

  const selectedRowIndices = useMemo(() => {
    const indices: number[] = [];
    if (gridSelection.rows) {
      for (const range of gridSelection.rows) {
        // CompactSelection stores [start, end) ranges
        if (Array.isArray(range)) {
          for (let i = range[0]; i < range[1]; i++) indices.push(i);
        } else {
          indices.push(range);
        }
      }
    }
    return indices;
  }, [gridSelection.rows]);

  const clearSelection = useCallback(() => {
    setGridSelection(EMPTY_SELECTION);
  }, []);

  return { gridSelection, onGridSelectionChange, selectedRowIndices, clearSelection };
}
