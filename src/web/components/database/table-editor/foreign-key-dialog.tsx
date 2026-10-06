/**
 * DBGate's foreign key editor: the constraint's name, the table it points at, its ON UPDATE and
 * ON DELETE actions, and the column pairs — "Base column" of this table, "Ref column" of the
 * other. Choosing a table while there are no pairs yet fills the Ref side in from that table's
 * primary key, which is what a foreign key points at nearly always.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "@/lib/icons";
import { targetUrl, type DbTarget } from "@/lib/db-tabs";
import type { DbObjectList, DbTableStructure, FkAction } from "../../../../shared/db-structure";
import type { DialectName } from "../../../../shared/db-types";
import {
  foreignKeyProblems, isSelfReference, keyNameTaken, newItemId, removeItem, upsertItem,
  type TableModel, type TableModelForeignKey,
} from "../../../../shared/db-table-model";
import { Field, SelectInput, TextInput } from "../connection-form/form-controls";
import { useDbRead } from "../use-db-read";
import { EditorDialog, type EditorDialogButton } from "./editor-dialog";
import { fkActionChoices, referencedTableChoices, tableChoiceKey, type TableChoice } from "./table-editor-model";

type ModelChange = (change: (model: TableModel) => TableModel) => void;

function structurePath(t: { schema: string | null; name: string }): string {
  return `/structure?table=${encodeURIComponent(t.name)}${t.schema ? `&schema=${encodeURIComponent(t.schema)}` : ""}`;
}

export function ForeignKeyDialog({ model, itemId, dialect, target, editable, onChange, onClose }: {
  model: TableModel;
  /** The key to edit; null adds one. */
  itemId: string | null;
  dialect: DialectName;
  target: DbTarget;
  editable: boolean;
  onChange: ModelChange;
  onClose: () => void;
}) {
  const original = itemId ? model.foreignKeys.find((f) => f.id === itemId) ?? null : null;
  const [draft, setDraft] = useState<TableModelForeignKey>(() => original ?? {
    id: newItemId(model), name: null, columns: [], refSchema: model.schema, refTable: "", refColumns: [], onUpdate: null, onDelete: null,
  });
  const [tried, setTried] = useState(false);
  // Set when a table was chosen with no pairs yet: its primary key fills them in once it is read.
  const [prefill, setPrefill] = useState(false);

  const tables = useDbRead<DbObjectList>(target, "/objects", undefined);
  const self = draft.refTable !== "" && isSelfReference(model, draft);
  const refRead = useDbRead<DbTableStructure>(target, draft.refTable && !self ? structurePath({ schema: draft.refSchema, name: draft.refTable }) : null, undefined);
  const refColumns: string[] | null = self ? model.columns.map((c) => c.name) : refRead.data ? refRead.data.columns.map((c) => c.name) : null;

  const choices = useMemo(() => {
    const list: TableChoice[] = tables.data ? referencedTableChoices(tables.data) : [];
    // The table being edited may not exist yet, and a key's table may be one the list lacks.
    const extra: TableChoice[] = [
      { schema: model.schema, name: model.name, label: model.schema ? `${model.schema}.${model.name}` : model.name },
      ...(original?.refTable ? [{ schema: original.refSchema, name: original.refTable, label: original.refSchema ? `${original.refSchema}.${original.refTable}` : original.refTable }] : []),
    ];
    for (const t of extra) if (t.name && !list.some((c) => tableChoiceKey(c) === tableChoiceKey(t))) list.push(t);
    return list;
  }, [tables.data, model.schema, model.name, original]);

  useEffect(() => {
    if (!prefill) return;
    const pk = self ? model.primaryKey?.columns.map((id) => model.columns.find((c) => c.id === id)?.name ?? "") : refRead.data?.primaryKey?.columns;
    if (!self && !refRead.data) return;
    setPrefill(false);
    if (pk && pk.length > 0) setDraft((d) => (d.columns.length > 0 ? d : { ...d, columns: pk.map(() => ""), refColumns: [...pk] }));
  }, [prefill, self, refRead.data, model]);

  const problems = useMemo(() => {
    const found = foreignKeyProblems(model, draft);
    if (keyNameTaken(model, draft.id, draft.name ?? "", dialect)) found.push(`Another key or index is named ${draft.name!.trim()}`);
    const missing = refColumns ? draft.refColumns.filter((r) => r && !refColumns.includes(r)) : [];
    if (missing.length > 0) found.push(`${draft.refTable} has no column ${missing.join(", ")}`);
    return found;
  }, [model, draft, dialect, refColumns]);

  const set = (patch: Partial<TableModelForeignKey>) => setDraft((d) => ({ ...d, ...patch }));
  const setPair = (i: number, side: "columns" | "refColumns", value: string) => setDraft((d) => ({ ...d, [side]: d[side].map((v, j) => (j === i ? value : v)) }));
  const chooseTable = (key: string) => {
    const t = choices.find((c) => tableChoiceKey(c) === key);
    set({ refSchema: t?.schema ?? model.schema, refTable: t?.name ?? "" });
    if (t && draft.columns.length === 0) setPrefill(true);
  };

  const save = () => {
    setTried(true);
    if (problems.length > 0) return;
    const fk = { ...draft, name: draft.name?.trim() || null };
    onChange((m) => upsertItem(m, "foreignKeys", fk));
    onClose();
  };
  const remove = () => {
    if (!original) return;
    onChange((m) => removeItem(m, "foreignKeys", original.id));
    onClose();
  };

  const buttons: EditorDialogButton[] = !editable
    ? [{ label: "Close", onClick: onClose }]
    : [
      { label: "Save", onClick: save, variant: "default" },
      { label: "Close", onClick: onClose },
      ...(original ? [{ label: "Remove", onClick: remove, variant: "destructive" as const }] : []),
    ];

  const id = (field: string) => `table-fk-${field}`;
  const off = !editable;
  const tableKey = draft.refTable ? tableChoiceKey({ schema: draft.refSchema, name: draft.refTable }) : "";
  const action = (field: "onUpdate" | "onDelete", label: string) => (
    <Field label={label} htmlFor={id(field)}>
      <SelectInput
        id={id(field)} value={draft[field] ?? ""} disabled={off}
        onChange={(e) => set({ [field]: (e.target.value || null) as FkAction | null })}
      >
        {fkActionChoices(draft[field]).map((c) => <option key={c.label} value={c.value ?? ""}>{c.label}</option>)}
      </SelectInput>
    </Field>
  );

  return (
    <EditorDialog
      title={original ? "Edit foreign key" : "Add foreign key"}
      description="The table this key points at, and the columns that point"
      onClose={onClose}
      onSubmit={editable ? save : undefined}
      problems={tried ? problems : []}
      buttons={buttons}
      wide
    >
      <Field label="Constraint name" htmlFor={id("name")}>
        <TextInput id={id("name")} value={draft.name ?? ""} disabled={off} mono onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Referenced table" htmlFor={id("table")} error={tables.error}>
        <div className="flex min-w-0 items-center gap-2">
          <SelectInput id={id("table")} value={tableKey} disabled={off} className="font-mono" onChange={(e) => chooseTable(e.target.value)}>
            <option value="">(not selected)</option>
            {choices.map((c) => <option key={tableChoiceKey(c)} value={tableChoiceKey(c)}>{c.label}</option>)}
          </SelectInput>
          {(tables.loading || refRead.loading) && <Loader2 aria-label="Loading" className="size-4 shrink-0 animate-spin text-text-subtle" />}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        {action("onUpdate", "On update action")}
        {action("onDelete", "On delete action")}
      </div>
      <div role="group" aria-label="Columns" className="grid gap-1.5">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_30px] gap-1.5 text-xs font-medium text-text-2">
          <span className="truncate">Base column - {model.name}</span>
          <span className="truncate">Ref column - {draft.refTable || "(table not set)"}</span>
        </div>
        {draft.columns.map((c, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_30px] items-center gap-1.5">
            <SelectInput aria-label={`Base column ${i + 1}`} value={c} disabled={off} className="font-mono" onChange={(e) => setPair(i, "columns", e.target.value)}>
              <option value="">(not selected)</option>
              {model.columns.map((col) => <option key={col.id} value={col.id}>{col.name}</option>)}
            </SelectInput>
            <SelectInput
              aria-label={`Ref column ${i + 1}`} value={draft.refColumns[i] ?? ""} disabled={off} className="font-mono"
              onChange={(e) => setPair(i, "refColumns", e.target.value)}
            >
              <option value="">(not selected)</option>
              {/* A column the key already names stays on offer while the other table is still being read. */}
              {[...new Set([...(refColumns ?? []), ...(draft.refColumns[i] ? [draft.refColumns[i]!] : [])])].map((r) => <option key={r} value={r}>{r}</option>)}
            </SelectInput>
            {editable ? (
              <button
                type="button" aria-label={`Delete column ${i + 1}`} title="Delete"
                onClick={() => set({ columns: draft.columns.filter((_, j) => j !== i), refColumns: draft.refColumns.filter((_, j) => j !== i) })}
                className="grid size-[30px] place-items-center rounded-md text-text-subtle can-hover:hover:bg-surface-hover can-hover:hover:text-error"
              >
                <Trash2 className="size-4" />
              </button>
            ) : <span />}
          </div>
        ))}
        {editable && (
          <button
            type="button"
            onClick={() => set({ columns: [...draft.columns, ""], refColumns: [...draft.refColumns, ""] })}
            className="flex h-[30px] w-fit items-center gap-1.5 rounded-md px-2 text-[12.5px] text-primary can-hover:hover:bg-surface-hover"
          >
            <Plus className="size-3.5" /> Add column
          </button>
        )}
      </div>
    </EditorDialog>
  );
}
