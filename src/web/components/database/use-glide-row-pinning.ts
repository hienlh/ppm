import { useState, useMemo } from "react";

interface UseGlideRowPinningResult {
  /** Rows reordered: unpinned first, pinned at end (frozen via freezeTrailingRows) */
  effectiveRows: Record<string, unknown>[];
  /** Number of pinned rows — pass to DataEditor's freezeTrailingRows */
  pinnedCount: number;
  pinnedPks: Set<string>;
  setPinnedPks: React.Dispatch<React.SetStateAction<Set<string>>>;
}

/**
 * Manages row pinning state — pinned rows placed at the end of the array
 * so they can be frozen at the bottom via Glide's freezeTrailingRows.
 */
export function useGlideRowPinning(
  rows: Record<string, unknown>[],
  pkCol: string | null,
): UseGlideRowPinningResult {
  const [pinnedPks, setPinnedPks] = useState<Set<string>>(new Set());

  const effectiveRows = useMemo(() => {
    if (pinnedPks.size === 0 || !pkCol) return rows;
    const normal: Record<string, unknown>[] = [];
    const pinned: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (pinnedPks.has(String(row[pkCol] ?? ""))) pinned.push(row); else normal.push(row);
    }
    return [...normal, ...pinned];
  }, [rows, pinnedPks, pkCol]);

  const pinnedCount = pinnedPks.size;

  return { effectiveRows, pinnedCount, pinnedPks, setPinnedPks };
}
