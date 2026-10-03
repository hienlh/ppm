/**
 * DBGate's one dialog for a primary key, a unique constraint and an index: a name, then a row per
 * column — its select and Delete — and "Add new column" to add one. An index also has ASC / DESC
 * per column, its type (MySQL) or "Is unique index" (Postgres, SQLite), and a filter condition
 * (Postgres, SQLite). A primary key has no name on MySQL and SQLite, which name none.
 *
 * An index part on an expression rather than a column is shown as it is written and can only be
 * deleted: the editor has no field to write one.
 */
import { useMemo, useState } from "react";
import { Trash2 } from "@/lib/icons";
import type { DialectName } from "../../../../shared/db-types";
import {
  autoConstraintName, columnName, keyNameTaken, keyProblems, newItemId, removeItem, upsertItem,
  type TableModel, type TableModelIndexColumn,
} from "../../../../shared/db-table-model";
import { CheckRow, Field, SelectInput, TextInput } from "../connection-form/form-controls";
import { EditorDialog, type EditorDialogButton } from "./editor-dialog";
import { mysqlIndexType, mysqlIndexTypeChoices, primaryKeyHasName, withMysqlIndexType } from "./table-editor-model";

export type KeyKind = "primaryKey" | "unique" | "index";

type ModelChange = (change: (model: TableModel) => TableModel) => void;

interface KeyDraft {
  id: string;
  name: string;
  parts: TableModelIndexColumn[];
  unique: boolean;
  method: string | null;
  where: string;
}

const LABEL: Record<KeyKind, string> = { primaryKey: "primary key", unique: "unique", index: "index" };

const part = (columnId: string): TableModelIndexColumn => ({ columnId, expression: null, descending: false });

function draftOf(model: TableModel, kind: KeyKind, itemId: string | null): { draft: KeyDraft; exists: boolean } {
  if (kind === "primaryKey" && model.primaryKey && (itemId === null || model.primaryKey.id === itemId)) {
    const pk = model.primaryKey;
    return { exists: true, draft: { id: pk.id, name: pk.name ?? "", parts: pk.columns.map(part), unique: true, method: null, where: "" } };
  }
  if (kind === "unique") {
    const u = model.uniques.find((x) => x.id === itemId);
    if (u) return { exists: true, draft: { id: u.id, name: u.name ?? "", parts: u.columns.map(part), unique: true, method: null, where: "" } };
  }
  if (kind === "index") {
    const ix = model.indexes.find((x) => x.id === itemId);
    if (ix) return { exists: true, draft: { id: ix.id, name: ix.name, parts: ix.columns.map((p) => ({ ...p })), unique: ix.unique, method: ix.method, where: ix.where ?? "" } };
  }
  return { exists: false, draft: { id: newItemId(model), name: "", parts: [], unique: false, method: null, where: "" } };
}

/** The model with the draft in it. */
function applyDraft(model: TableModel, kind: KeyKind, d: KeyDraft, dialect: DialectName): TableModel {
  const columns = d.parts.flatMap((p) => (p.columnId !== null ? [p.columnId] : []));
  if (kind === "primaryKey") {
    const name = primaryKeyHasName(dialect) ? d.name.trim() || null : model.primaryKey?.name ?? null;
    return { ...model, primaryKey: { id: d.id, name, columns } };
  }
  if (kind === "unique") return upsertItem(model, "uniques", { id: d.id, name: d.name.trim() || null, columns });
  return upsertItem(model, "indexes", {
    id: d.id, name: d.name.trim(), columns: d.parts, unique: d.unique, method: d.method, where: d.where.trim() || null,
  });
}

export function KeyDialog({ kind, model, itemId, dialect, editable, onChange, onClose }: {
  kind: KeyKind;
  model: TableModel;
  /** The item to edit; null adds one (for the primary key: edits the one there is). */
  itemId: string | null;
  dialect: DialectName;
  editable: boolean;
  onChange: ModelChange;
  onClose: () => void;
}) {
  const [{ draft: start, exists }] = useState(() => draftOf(model, kind, itemId));
  const [draft, setDraft] = useState<KeyDraft>(start);
  const [tried, setTried] = useState(false);
  const named = kind !== "primaryKey" || primaryKeyHasName(dialect);

  const problems = useMemo(() => {
    const found = keyProblems(model, draft.parts.map((p) => p.columnId), kind);
    if (named && keyNameTaken(model, draft.id, draft.name, dialect)) found.push(`Another key or index is named ${draft.name.trim()}`);
    return found;
  }, [model, draft, kind, named, dialect]);

  const set = (patch: Partial<KeyDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setPart = (i: number, patch: Partial<TableModelIndexColumn>) => set({ parts: draft.parts.map((p, j) => (j === i ? { ...p, ...patch } : p)) });

  const save = () => {
    setTried(true);
    if (problems.length > 0) return;
    onChange((m) => applyDraft(m, kind, draft, dialect));
    onClose();
  };
  const remove = () => {
    onChange((m) => removeItem(m, kind === "primaryKey" ? "primaryKey" : kind === "unique" ? "uniques" : "indexes", draft.id));
    onClose();
  };

  const buttons: EditorDialogButton[] = !editable
    ? [{ label: "Close", onClick: onClose }]
    : [
      { label: "Save", onClick: save, variant: "default" },
      { label: "Close", onClick: onClose },
      ...(exists ? [{ label: "Remove", onClick: remove, variant: "destructive" as const }] : []),
    ];

  const used = new Set(draft.parts.map((p) => p.columnId));
  const unused = model.columns.filter((c) => !used.has(c.id));
  const chosenNames = draft.parts.map((p) => (p.columnId !== null ? columnName(model, p.columnId) : "")).filter(Boolean);
  const autoName = autoConstraintName(kind === "primaryKey" ? "PK" : kind === "unique" ? "UQ" : "IX", model.name, chosenNames);
  const id = (field: string) => `table-key-${field}`;
  const off = !editable;

  return (
    <EditorDialog
      title={`${exists ? "Edit" : "Add"} ${LABEL[kind]}`}
      description={`The columns of the ${LABEL[kind]}`}
      onClose={onClose}
      onSubmit={editable ? save : undefined}
      problems={tried ? problems : []}
      buttons={buttons}
    >
      {named && (
        <Field label={kind === "index" ? "Index name" : "Constraint name"} htmlFor={id("name")}>
          <TextInput
            id={id("name")} value={draft.name} disabled={off} mono
            // Left empty, Save names it as DBGate does.
            placeholder={editable ? autoName : undefined}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
      )}
      {kind === "index" && dialect === "mysql" && (
        <Field label="Index type" htmlFor={id("type")}>
          <SelectInput id={id("type")} value={mysqlIndexType(draft)} disabled={off} onChange={(e) => setDraft((d) => withMysqlIndexType(d, e.target.value))}>
            {mysqlIndexTypeChoices(draft).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </SelectInput>
        </Field>
      )}
      {kind === "index" && dialect !== "mysql" && (
        <CheckRow id={id("unique")} title="Is unique index" checked={draft.unique} disabled={off} onChange={(v) => set({ unique: v })} />
      )}
      <div role="group" aria-labelledby={id("columns")} className="grid gap-1.5">
        <span id={id("columns")} className="text-xs font-medium text-text-2">Columns</span>
        {draft.parts.map((p, i) => (
          <div key={p.columnId ?? `expr-${i}`} className="flex min-w-0 items-center gap-1.5">
            {p.columnId !== null ? (
              <SelectInput
                aria-label={`Column ${i + 1}`} value={p.columnId} disabled={off} className="font-mono"
                onChange={(e) => setPart(i, { columnId: e.target.value })}
              >
                {model.columns.filter((c) => c.id === p.columnId || !used.has(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </SelectInput>
            ) : (
              <TextInput aria-label={`Expression ${i + 1}`} value={p.expression ?? ""} disabled mono title="An expression, which the editor keeps as it is written" />
            )}
            {kind === "index" && (
              <SelectInput
                aria-label={`Order of column ${i + 1}`} value={p.descending ? "desc" : "asc"} disabled={off} className="w-24 shrink-0"
                onChange={(e) => setPart(i, { descending: e.target.value === "desc" })}
              >
                <option value="asc">ASC</option>
                <option value="desc">DESC</option>
              </SelectInput>
            )}
            {editable && (
              <button
                type="button" aria-label={`Delete column ${i + 1}`} title="Delete"
                onClick={() => set({ parts: draft.parts.filter((_, j) => j !== i) })}
                className="grid size-[30px] shrink-0 place-items-center rounded-md text-text-subtle can-hover:hover:bg-surface-hover can-hover:hover:text-error"
              >
                <Trash2 className="size-4" />
              </button>
            )}
          </div>
        ))}
        {editable && unused.length > 0 && (
          <SelectInput
            aria-label="Add new column" value=""
            onChange={(e) => { if (e.target.value) set({ parts: [...draft.parts, part(e.target.value)] }); }}
          >
            <option value="">Add new column — Choose column</option>
            {unused.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </SelectInput>
        )}
      </div>
      {kind === "index" && dialect !== "mysql" && (
        <Field label="Filtered index condition" htmlFor={id("where")}>
          <TextInput id={id("where")} value={draft.where} disabled={off} mono onChange={(e) => set({ where: e.target.value })} />
        </Field>
      )}
    </EditorDialog>
  );
}
