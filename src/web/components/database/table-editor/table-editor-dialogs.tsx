/**
 * The one dialog of the table editor that is open: a column's, a key's or an index's, or a foreign
 * key's. Keyed by what it edits, so opening another one starts from that one's fields.
 */
import type { DbTarget } from "@/lib/db-tabs";
import type { DialectName } from "../../../../shared/db-types";
import type { TableModel } from "../../../../shared/db-table-model";
import { ColumnDialog } from "./column-dialog";
import { ForeignKeyDialog } from "./foreign-key-dialog";
import { KeyDialog } from "./key-dialog";
import type { EditorDialogState, ModelChange } from "./table-editor";

export function TableEditorDialogs({ dialog, model, dialect, target, editable, onChange, onClose }: {
  dialog: EditorDialogState | null;
  model: TableModel;
  dialect: DialectName;
  target: DbTarget;
  editable: boolean;
  onChange: ModelChange;
  onClose: () => void;
}) {
  if (!dialog) return null;
  const common = { model, dialect, editable, onChange, onClose };
  switch (dialog.kind) {
    case "column":
      return <ColumnDialog key={`column:${dialog.id ?? "new"}`} columnId={dialog.id} {...common} />;
    case "key":
      return <KeyDialog key={`${dialog.keyKind}:${dialog.id ?? "new"}`} kind={dialog.keyKind} itemId={dialog.id} {...common} />;
    case "foreignKey":
      return <ForeignKeyDialog key={`fk:${dialog.id ?? "new"}`} itemId={dialog.id} target={target} {...common} />;
  }
}
