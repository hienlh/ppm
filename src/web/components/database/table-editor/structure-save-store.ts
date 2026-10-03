/**
 * The one Save changes dialog of the app, asked for by whatever changes a table's structure: the
 * Structure tab's Save, and the tree's Drop, Rename, Truncate and Create table backup. The dialog
 * itself (`structure-save-host.tsx`) reads the script, shows it, runs it on OK, and tells the one
 * who asked when the change is in the database. A rename asks for the new name first.
 */
import { create } from "zustand";
import type { DbTarget } from "@/lib/db-tabs";
import type { StructureChange } from "../../../../shared/db-structure-change";
import type { DbTabPlace } from "../explorer/open-db-tabs";

export interface StructureSaveRequest {
  target: DbTarget;
  /** Where Open script opens its Query tab. */
  place: DbTabPlace;
  change: StructureChange;
  /** The change is in the database: the asker drops what it kept of it and reads the table again. */
  onSaved?: () => void;
}

/** DBGate's "Rename object": a new name for a table or a column, which then goes through Save changes. */
export interface RenameRequest {
  /** The name it has now, which the field starts from. */
  value: string;
  onConfirm: (newName: string) => void;
}

interface StructureSaveState {
  request: StructureSaveRequest | null;
  /** Tells one request from the next, so a dialog never answers for another one's change. */
  seq: number;
  rename: RenameRequest | null;
}

export const useStructureSave = create<StructureSaveState>(() => ({ request: null, seq: 0, rename: null }));

export function requestStructureChange(request: StructureSaveRequest): void {
  useStructureSave.setState((s) => ({ request, seq: s.seq + 1 }));
}

/** The dialog closed; `seq` is the request it was showing, so a newer one stays. */
export function endStructureSave(seq: number): void {
  if (useStructureSave.getState().seq === seq) useStructureSave.setState({ request: null });
}

export function askNewName(rename: RenameRequest): void {
  useStructureSave.setState({ rename });
}

export function endRename(): void {
  useStructureSave.setState({ rename: null });
}
