/**
 * A grid's change set in React state, with DBGate's undo and redo: every edit, new row, clone,
 * deletion and revert is one step. The rules are `grid-changeset.ts`; this only keeps the steps and
 * hands the canvas a ref, since Glide reads cells outside React's render.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  EMPTY_HISTORY, NEW_ROW_PREFIX, changedRowCount, editCells, isEmptyChangeset, recordChange, redoChange, undoChange,
  type CellChange, type ChangesetHistory, type GridChangeset, type PendingEdit,
} from "./grid-changeset";

export function useChangeset(pkCol: string | null, keyCols: readonly string[]) {
  const [history, setHistory] = useState<ChangesetHistory>(EMPTY_HISTORY);
  const changeset = history.present;
  // Glide draws from `getCellContent`, which must stay one function: it reads the cells through this.
  const pendingRef = useRef<ReadonlyMap<string, PendingEdit>>(changeset.cells);
  pendingRef.current = changeset.cells;
  const changesetRef = useRef(changeset);
  changesetRef.current = changeset;

  /** One step: whatever `step` makes of the change set. A step that changes nothing is not one. */
  const change = useCallback((step: (cs: GridChangeset) => GridChangeset) => {
    setHistory((h) => recordChange(h, step(h.present)));
  }, []);

  const edit = useCallback((changes: readonly CellChange[]) => {
    if (!pkCol || changes.length === 0) return;
    change((cs) => editCells(cs, changes, pkCol, keyCols));
  }, [pkCol, keyCols, change]);

  const seq = useRef(0);
  const newRowId = useCallback(() => `${NEW_ROW_PREFIX}${Date.now()}_${++seq.current}`, []);

  const undo = useCallback(() => setHistory(undoChange), []);
  const redo = useCallback(() => setHistory(redoChange), []);
  /** Nothing pending and nothing to undo: after a save, whose changes the database now holds. */
  const reset = useCallback(() => setHistory(EMPTY_HISTORY), []);

  const changedRows = useMemo(() => changedRowCount(changeset), [changeset]);

  return {
    changeset, changesetRef, pendingRef, change, edit, newRowId, undo, redo, reset,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    hasChanges: !isEmptyChangeset(changeset),
    changedRows,
  };
}
