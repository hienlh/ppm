/**
 * The table editor's entries in the command palette — DBGate's Add column, Add primary key and the
 * rest — offered by the Structure tab that is in front, and only while its table can be changed.
 */
import { create } from "zustand";

export interface TableEditorCommand {
  id: string;
  label: string;
  run: () => void;
}

interface TableEditorCommandsState {
  /** The tab offering them. */
  owner: string | null;
  commands: readonly TableEditorCommand[];
}

export const useTableEditorCommands = create<TableEditorCommandsState>(() => ({ owner: null, commands: [] }));

/** Offers `commands` on behalf of the tab `owner`; the returned function takes them back. */
export function offerTableEditorCommands(owner: string, commands: readonly TableEditorCommand[]): () => void {
  useTableEditorCommands.setState({ owner, commands });
  return () => {
    if (useTableEditorCommands.getState().owner === owner) useTableEditorCommands.setState({ owner: null, commands: [] });
  };
}
