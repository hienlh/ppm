/**
 * DBGate's column editor: "Add column N" for a new one, "Edit column" for one the table has. Save
 * and next saves and starts the next new column at once, which is how a table is laid out column
 * after column. It does not close on a column that could only fail at Save — no name, a name
 * taken, no type, an autoincrement that is not an integer.
 */
import { useMemo, useState } from "react";
import type { DialectName } from "../../../../shared/db-types";
import {
  blankColumn, columnById, columnProblems, isPrimaryKeyColumn, newItemId, removeColumns, upsertColumn,
  type TableModel, type TableModelColumn,
} from "../../../../shared/db-table-model";
import { CheckRow, Field, TextInput } from "../connection-form/form-controls";
import { EditorDialog, TextWithList, type EditorDialogButton } from "./editor-dialog";
import { dataTypesFor, nextColumnNumber } from "./table-editor-model";

type ModelChange = (change: (model: TableModel) => TableModel) => void;

const DEFAULT_VALUE_LABEL = "Default value. Please use valid SQL expression, eg. 'Hello World' for string value, '' for empty string";

/** An empty box is no value at all: the model's null. */
const orNull = (s: string) => (s.trim() === "" ? null : s);

export function ColumnDialog({ model, columnId, dialect, editable, onChange, onClose }: {
  model: TableModel;
  /** The column to edit; null adds one. */
  columnId: string | null;
  dialect: DialectName;
  editable: boolean;
  onChange: ModelChange;
  onClose: () => void;
}) {
  const original = columnId ? columnById(model, columnId) ?? null : null;
  const [draft, setDraft] = useState<TableModelColumn>(() => original ?? blankColumn(newItemId(model)));
  const [primaryKey, setPrimaryKey] = useState(() => (original ? isPrimaryKeyColumn(model, original.id) : false));
  const [number, setNumber] = useState(() => nextColumnNumber(model));
  const [tried, setTried] = useState(false);
  const adding = original === null;

  const set = <K extends keyof TableModelColumn>(key: K, value: TableModelColumn[K]) => setDraft((d) => ({ ...d, [key]: value }));
  // Spaces typed around a new name or type are not part of it; an existing column keeps what it has.
  const saved = (): TableModelColumn => ({
    ...draft,
    name: draft.name === original?.name ? draft.name : draft.name.trim(),
    type: draft.type === original?.type ? draft.type : draft.type.trim(),
  });
  const problems = useMemo(() => columnProblems(model, saved(), dialect), [model, draft, dialect]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (): TableModel | null => {
    setTried(true);
    if (problems.length > 0) return null;
    const column = saved();
    const next = upsertColumn(model, column, primaryKey);
    onChange((m) => upsertColumn(m, column, primaryKey));
    return next;
  };
  const saveAndClose = () => { if (save()) onClose(); };
  const saveAndNext = () => {
    const next = save();
    if (!next) return;
    setDraft(blankColumn(newItemId(next)));
    setPrimaryKey(false);
    setNumber(nextColumnNumber(next));
    setTried(false);
  };
  const remove = () => {
    if (!original) return;
    onChange((m) => removeColumns(m, [original.id]));
    onClose();
  };

  const buttons: EditorDialogButton[] = !editable
    ? [{ label: "Close", onClick: onClose }]
    : adding
      ? [{ label: "Save and next", onClick: saveAndNext, variant: "default" }, { label: "Save", onClick: saveAndClose }, { label: "Close", onClick: onClose }]
      : [{ label: "Save", onClick: saveAndClose, variant: "default" }, { label: "Close", onClick: onClose }, { label: "Remove", onClick: remove, variant: "destructive" }];

  const id = (field: string) => `table-column-${field}`;
  const off = !editable;
  return (
    <EditorDialog
      title={adding ? `Add column ${number}` : "Edit column"}
      description={adding ? "A new column of the table" : `The column ${original.name}`}
      onClose={onClose}
      onSubmit={editable ? (adding ? saveAndNext : saveAndClose) : undefined}
      problems={tried ? problems : []}
      buttons={buttons}
    >
      <Field label="Column name" htmlFor={id("name")}>
        <TextInput id={id("name")} value={draft.name} disabled={off} autoFocus={editable} mono onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field label="Data type" htmlFor={id("type")}>
        <TextWithList
          id={id("type")} value={draft.type} onChange={(v) => set("type", v)} options={dataTypesFor(dialect)}
          disabled={off} listLabel="Choose a data type" mono
        />
      </Field>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <CheckRow id={id("not-null")} title="NOT NULL" checked={draft.notNull} disabled={off} onChange={(v) => set("notNull", v)} />
        <CheckRow id={id("pk")} title="Is Primary Key" checked={primaryKey} disabled={off} onChange={setPrimaryKey} />
        <CheckRow
          id={id("auto")} title="Is Autoincrement" checked={draft.autoIncrement} disabled={off}
          // An autoincrement column is never NULL, as DBGate ticks it.
          onChange={(v) => setDraft((d) => ({ ...d, autoIncrement: v, notNull: v ? true : d.notNull }))}
        />
        {dialect === "mysql" && (
          <>
            <CheckRow id={id("unsigned")} title="Unsigned" checked={draft.unsigned} disabled={off} onChange={(v) => set("unsigned", v)} />
            <CheckRow id={id("zerofill")} title="Zero fill" checked={draft.zerofill} disabled={off} onChange={(v) => set("zerofill", v)} />
          </>
        )}
      </div>
      <Field label={DEFAULT_VALUE_LABEL} htmlFor={id("default")}>
        <TextInput id={id("default")} value={draft.defaultValue ?? ""} disabled={off} mono onChange={(e) => set("defaultValue", orNull(e.target.value))} />
      </Field>
      <Field label="Computed expression" htmlFor={id("computed")}>
        <TextInput
          id={id("computed")} value={draft.computedExpression ?? ""} disabled={off} mono
          onChange={(e) => set("computedExpression", orNull(e.target.value))}
        />
      </Field>
      {dialect === "mysql" && (
        <Field label="Comment" htmlFor={id("comment")}>
          <TextInput id={id("comment")} value={draft.comment ?? ""} disabled={off} onChange={(e) => set("comment", orNull(e.target.value))} />
        </Field>
      )}
    </EditorDialog>
  );
}
