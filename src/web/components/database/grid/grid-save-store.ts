/**
 * The one Save changes dialog for a grid's rows, asked for by a table's data tab and by an
 * editable query result. `requestGridSave` shows the request (`grid-save-host.tsx`) and answers
 * once the changes are in the database; closing the dialog without saving answers
 * `GridSaveCancelled`, and the grid keeps every change it had.
 */
import { create } from "zustand";
import type { DbTarget } from "@/lib/db-tabs";
import type { ChangesetApplyResult } from "../../../../shared/db-changeset";
import type { DbTabPlace } from "../explorer/open-db-tabs";
import type { GridChanges } from "../glide-grid-types";

export interface GridSaveRequest {
  target: DbTarget;
  /** Where Open script opens its Query tab; without one there is no Open script. */
  place: DbTabPlace | null;
  table: string;
  /** As the grid read the table: empty for the connection's own schema. */
  schema: string;
  changes: GridChanges;
}

/** The dialog closed with nothing saved: the grid keeps its changes, and says nothing more. */
export class GridSaveCancelled extends Error {
  constructor() {
    super("The changes were not saved");
    this.name = "GridSaveCancelled";
  }
}

interface PendingSave {
  request: GridSaveRequest;
  seq: number;
  resolve: (result: ChangesetApplyResult) => void;
  reject: (reason: GridSaveCancelled) => void;
}

interface GridSaveState {
  pending: PendingSave | null;
  /** Tells one save from the next, so a dialog never answers for another one's changes. */
  seq: number;
}

export const useGridSave = create<GridSaveState>(() => ({ pending: null, seq: 0 }));

/**
 * One save at a time: the one under way may be writing already, and putting another in its place
 * would leave its grid holding changes the database has — saved a second time on the next Save.
 */
export function requestGridSave(request: GridSaveRequest): Promise<ChangesetApplyResult> {
  const { pending, seq } = useGridSave.getState();
  if (pending) return Promise.reject(new GridSaveCancelled());
  return new Promise((resolve, reject) => {
    useGridSave.setState({ seq: seq + 1, pending: { request, seq: seq + 1, resolve, reject } });
  });
}

/** The dialog for save `seq` is done: with what was saved, or with nothing. A newer save stays. */
export function endGridSave(seq: number, result: ChangesetApplyResult | null): void {
  const { pending } = useGridSave.getState();
  if (pending?.seq !== seq) return;
  useGridSave.setState({ pending: null });
  if (result) pending.resolve(result);
  else pending.reject(new GridSaveCancelled());
}
