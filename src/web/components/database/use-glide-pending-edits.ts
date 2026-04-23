import { useState, useCallback, useRef } from "react";

export interface PendingEdit {
  pkVal: unknown;
  col: string;
  newVal: unknown;
}

interface UseGlidePendingEditsResult {
  pendingEdits: Map<string, PendingEdit>;
  pendingRef: React.RefObject<Map<string, PendingEdit>>;
  addEdit: (pkVal: unknown, col: string, newVal: unknown) => void;
  commitAll: () => Promise<void>;
  discardAll: () => void;
  hasPending: boolean;
  pendingCount: number;
  /** True after commitAll until cleared — used to clear edits on rows refresh */
  committedRef: React.RefObject<boolean>;
}

/**
 * Tracks cell edits locally until the user explicitly saves.
 * After commit, keeps pending values visible until rows refresh (avoids flash of stale data).
 * Supports inline insert: edits with PK starting "__new_" are routed to onInsertRow.
 */
export function useGlidePendingEdits(
  pkCol: string | null,
  onCellUpdate: (pkCol: string, pkVal: unknown, col: string, val: unknown) => void,
  onInsertRow?: (values: Record<string, unknown>) => Promise<void>,
): UseGlidePendingEditsResult {
  const [pendingEdits, setPendingEdits] = useState<Map<string, PendingEdit>>(new Map());
  const pendingRef = useRef(pendingEdits);
  pendingRef.current = pendingEdits;
  const committedRef = useRef(false);

  const addEdit = useCallback((pkVal: unknown, col: string, newVal: unknown) => {
    const key = `${pkVal}:${col}`;
    setPendingEdits((prev) => new Map(prev).set(key, { pkVal, col, newVal }));
  }, []);

  const commitAll = useCallback(async () => {
    if (!pkCol) return;
    const newRows = new Map<string, Record<string, unknown>>();
    for (const edit of pendingRef.current.values()) {
      const pkStr = String(edit.pkVal);
      if (pkStr.startsWith("__new_")) {
        if (!newRows.has(pkStr)) newRows.set(pkStr, {});
        newRows.get(pkStr)![edit.col] = edit.newVal;
      } else {
        onCellUpdate(pkCol, edit.pkVal, edit.col, edit.newVal);
      }
    }
    if (onInsertRow) {
      for (const values of newRows.values()) {
        await onInsertRow(values);
      }
    }
    committedRef.current = true;
    // Don't clear — wait for rows prop to refresh so grid doesn't flash stale data
  }, [pkCol, onCellUpdate, onInsertRow]);

  const discardAll = useCallback(() => {
    setPendingEdits(new Map());
    committedRef.current = false;
  }, []);

  return {
    pendingEdits, pendingRef, addEdit, commitAll, discardAll,
    hasPending: pendingEdits.size > 0, pendingCount: pendingEdits.size,
    committedRef,
  };
}
