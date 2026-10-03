/**
 * DBGate's table editor, drawn on the Structure tab of a desktop: Table properties when there are
 * any, then a section each for the columns, the primary key, the indexes, the unique constraints,
 * the foreign keys and the keys other tables hold on this one (Dependencies). A section folds
 * away, counts its items, offers Add new, and takes a row's Remove; a click on a row opens its
 * dialog. On a connection that refuses writes, and for a view, the same sections only show: a row
 * still opens its dialog, with every field locked, and empty sections are left out.
 *
 * The columns take a selection as DBGate's list does — drag across rows, Shift for a range,
 * Ctrl/⌘ for one more — and the selection's Remove, Copy names and Copy definitions.
 */
import { cloneElement, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { toast } from "sonner";
import { CheckCircle, ChevronDown, ChevronRight, Copy, Key, Link, ListOrdered, Plus } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import type { DbForeignKey } from "../../../../shared/db-structure";
import type { DbType, DialectName } from "../../../../shared/db-types";
import { removeColumns, removeItem, type TableModel } from "../../../../shared/db-table-model";
import { RowMenuContent, type MenuEntry } from "../explorer/explorer-menu";
import { useRowMenu } from "../explorer/use-row-menu";
import { Field, SelectInput, TextInput } from "../connection-form/form-controls";
import { foreignKeyRow } from "../structure/structure-model";
import { TextWithList } from "./editor-dialog";
import {
  editorColumnRows, enginesFor, foreignKeyRows, indexRows, modelColumnDefinitions, modelColumnNames, primaryKeyHasName,
  primaryKeyRow, uniqueRows, withTableName,
} from "./table-editor-model";
import type { KeyKind } from "./key-dialog";

export type ModelChange = (change: (model: TableModel) => TableModel) => void;

/** Which dialog the editor shows: a row's, or Add new's (`id` null). */
export type EditorDialogState =
  | { kind: "column"; id: string | null }
  | { kind: "key"; keyKind: KeyKind; id: string | null }
  | { kind: "foreignKey"; id: string | null };

export function TableEditor({ model, dialect, dbType, editable, isNew, references, schemas, onChange, openDialog }: {
  model: TableModel;
  dialect: DialectName;
  dbType: DbType;
  editable: boolean;
  /** Not created yet: its name and schema are the editor's to set. */
  isNew: boolean;
  /** Other tables' keys onto this one, as the database has them. */
  references: readonly DbForeignKey[];
  /** The schemas a new table can go in (Postgres); null while unknown. */
  schemas: readonly string[] | null;
  onChange: ModelChange;
  openDialog: (dialog: EditorDialogState) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const fold = (id: string) => ({
    collapsed: collapsed.has(id),
    onToggle: () => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
  });

  const pk = primaryKeyRow(model);
  const indexes = useMemo(() => indexRows(model), [model]);
  const uniques = useMemo(() => uniqueRows(model), [model]);
  const fks = useMemo(() => foreignKeyRows(model), [model]);
  const deps = useMemo(() => references.map((fk) => foreignKeyRow(fk, model.schema)), [references, model.schema]);
  const hasColumns = model.columns.length > 0;
  // A section with nothing in it shows only where something can be added to it, as DBGate's do.
  const shows = (count: number) => editable || count > 0;
  const remove = (section: "primaryKey" | "indexes" | "uniques" | "foreignKeys", id: string) => onChange((m) => removeItem(m, section, id));
  const pkNamed = primaryKeyHasName(dialect);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-[18px] px-[18px] pt-3.5 pb-7">
      <TableProperties model={model} dbType={dbType} dialect={dialect} editable={editable} isNew={isNew} schemas={schemas} onChange={onChange} />
      <ColumnsSection model={model} dialect={dialect} editable={editable} onChange={onChange} openDialog={openDialog} {...fold("columns")} />
      {shows(pk ? 1 : 0) && (
        <EditorSection
          title="Primary key" {...fold("pk")}
          onAddNew={editable && !pk && hasColumns ? () => openDialog({ kind: "key", keyKind: "primaryKey", id: null }) : undefined}
          empty={!pk ? "No primary key defined" : null}
          head={[...(pkNamed ? ["Name"] : []), "Columns", ...(editable ? [""] : [])]}
        >
          {pk && (
            <ClickRow onOpen={() => openDialog({ kind: "key", keyKind: "primaryKey", id: pk.id })} label={`Primary key on ${pk.columns}`}>
              {pkNamed && <td className={CELL}><Named icon={<Key className="size-[15px] shrink-0 text-warning" aria-hidden />} name={pk.name} /></td>}
              <td className={CELL}>
                {pkNamed ? pk.columns : <span className="inline-flex items-center gap-1.5"><Key className="size-[15px] shrink-0 text-warning" aria-hidden />{pk.columns}</span>}
              </td>
              {editable && <RemoveCell onRemove={() => remove("primaryKey", pk.id)} />}
            </ClickRow>
          )}
        </EditorSection>
      )}
      {shows(indexes.length) && (
        <EditorSection
          title={`Indexes (${indexes.length})`} {...fold("indexes")}
          onAddNew={editable && hasColumns ? () => openDialog({ kind: "key", keyKind: "index", id: null }) : undefined}
          empty={indexes.length === 0 ? "No index defined" : null}
          head={["Name", "Columns", "Unique", ...(editable ? [""] : [])]}
        >
          {indexes.map((ix) => (
            <ClickRow key={ix.id} onOpen={() => openDialog({ kind: "key", keyKind: "index", id: ix.id })} label={`Index ${ix.name ?? ix.columns}`}>
              <td className={CELL}><Named icon={<ListOrdered className="size-[15px] shrink-0 text-text-subtle" aria-hidden />} name={ix.name} /></td>
              <td className={CELL}>{ix.columns}</td>
              <td className={CELL}>{ix.unique ? "YES" : "NO"}</td>
              {editable && <RemoveCell onRemove={() => remove("indexes", ix.id)} />}
            </ClickRow>
          ))}
        </EditorSection>
      )}
      {shows(uniques.length) && (
        <EditorSection
          title={`Unique constraints (${uniques.length})`} {...fold("uniques")}
          onAddNew={editable && hasColumns ? () => openDialog({ kind: "key", keyKind: "unique", id: null }) : undefined}
          empty={uniques.length === 0 ? "No unique defined" : null}
          head={["Name", "Columns", ...(editable ? [""] : [])]}
        >
          {uniques.map((u) => (
            <ClickRow key={u.id} onOpen={() => openDialog({ kind: "key", keyKind: "unique", id: u.id })} label={`Unique constraint ${u.name ?? u.columns}`}>
              <td className={CELL}><Named icon={<CheckCircle className="size-[15px] shrink-0 text-text-subtle" aria-hidden />} name={u.name} /></td>
              <td className={CELL}>{u.columns}</td>
              {editable && <RemoveCell onRemove={() => remove("uniques", u.id)} />}
            </ClickRow>
          ))}
        </EditorSection>
      )}
      {shows(fks.length) && (
        <EditorSection
          title={`Foreign keys (${fks.length})`} {...fold("fks")}
          onAddNew={editable && hasColumns ? () => openDialog({ kind: "foreignKey", id: null }) : undefined}
          empty={fks.length === 0 ? "No foreign key defined" : null}
          head={[...FK_HEAD, ...(editable ? [""] : [])]}
        >
          {fks.map((fk) => (
            <ClickRow key={fk.id} onOpen={() => openDialog({ kind: "foreignKey", id: fk.id })} label={`Foreign key ${fk.name ?? fk.baseColumns}`}>
              <td className={CELL}><Named icon={<Link className="size-[15px] shrink-0 text-info" aria-hidden />} name={fk.name} /></td>
              <td className={CELL}>{fk.baseColumns}</td>
              <td className={CELL}>{fk.refTable}</td>
              <td className={CELL}>{fk.refColumns}</td>
              <td className={CELL}>{fk.onUpdate}</td>
              <td className={CELL}>{fk.onDelete}</td>
              {/* DBGate left this Remove on a connection that refuses writes; here it goes with the rest. */}
              {editable && <RemoveCell onRemove={() => remove("foreignKeys", fk.id)} />}
            </ClickRow>
          ))}
        </EditorSection>
      )}
      {deps.length > 0 && (
        <EditorSection title={`Dependencies (${deps.length})`} {...fold("deps")} empty={null} head={FK_HEAD}>
          {deps.map((fk, i) => (
            <tr key={`${fk.holder}\u0000${fk.name ?? i}`} className={ROW}>
              <td className={CELL}>
                <Named
                  icon={<Link className="size-[15px] shrink-0 text-info" aria-hidden />}
                  name={fk.name}
                  title={`${fk.holder} (${fk.baseColumns}) → ${fk.refTable} (${fk.refColumns})`}
                />
              </td>
              <td className={CELL}>{fk.baseColumns}</td>
              <td className={CELL}>{fk.refTable}</td>
              <td className={CELL}>{fk.refColumns}</td>
              <td className={CELL}>{fk.onUpdate}</td>
              <td className={CELL}>{fk.onDelete}</td>
            </tr>
          ))}
        </EditorSection>
      )}
    </div>
  );
}

const ROW = "can-hover:hover:bg-surface-hover";
const CELL = "whitespace-nowrap border-b border-border-soft px-2.5 py-1.5";
const MONO = "font-mono text-[11.5px]";
const FK_HEAD = ["Name", "Base columns", "Referenced table", "Referenced columns", "ON UPDATE", "ON DELETE"];

function EditorSection({ title, collapsed, onToggle, onAddNew, actions, empty, head, children, wrapBox }: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  onAddNew?: () => void;
  /** Beside the title: what the selection can be acted on with. */
  actions?: ReactNode;
  /** Said in place of the list when it has nothing; null when it has. */
  empty: string | null;
  head: string[];
  children: ReactNode;
  /** Wraps the list's box, e.g. in the trigger of a menu for its rows. */
  wrapBox?: (box: ReactElement) => ReactNode;
}) {
  const box = (
    <div className="overflow-x-auto rounded-md border border-border bg-panel-2">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className="whitespace-nowrap border-b border-border-soft bg-panel px-2.5 py-1.5 text-left text-[11px] font-semibold text-text-subtle">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr:last-child>td]:border-b-0">{children}</tbody>
      </table>
    </div>
  );
  return (
    <section aria-label={title}>
      <div className="mb-1.5 flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button" onClick={onToggle} aria-expanded={!collapsed}
          className="-ml-1 flex items-center gap-1 rounded px-1 text-[12.5px] font-semibold text-text-primary can-hover:hover:bg-surface-hover"
        >
          {collapsed ? <ChevronRight className="size-3.5 text-text-subtle" aria-hidden /> : <ChevronDown className="size-3.5 text-text-subtle" aria-hidden />}
          <h3>{title}</h3>
        </button>
        {onAddNew && (
          <button type="button" onClick={onAddNew} className="flex items-center gap-1 rounded px-1 text-xs text-primary underline-offset-2 can-hover:hover:underline">
            <Plus className="size-3.5" aria-hidden /> Add new
          </button>
        )}
        {actions}
      </div>
      {empty ? <p className="ml-0.5 text-xs italic text-text-subtle">{empty}</p> : !collapsed && (wrapBox ? wrapBox(box) : box)}
    </section>
  );
}

/** A row that opens its dialog: on a click, or Enter once it has focus. */
function ClickRow({ onOpen, label, children }: { onOpen: () => void; label: string; children: ReactNode }) {
  return (
    <tr
      tabIndex={0}
      aria-label={label}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); onOpen(); } }}
      className={cn(ROW, "cursor-pointer select-none outline-none focus-visible:bg-accent-wash")}
    >
      {children}
    </tr>
  );
}

function RemoveCell({ onRemove }: { onRemove: () => void }) {
  return (
    <td className={cn(CELL, "w-px text-right")}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        onKeyDown={(e) => e.stopPropagation()}
        className="rounded px-1 text-xs text-primary underline-offset-2 can-hover:hover:underline"
      >
        Remove
      </button>
    </td>
  );
}

/** A name, or — SQLite names no key or constraint, and Save names a new one — a dimmed "unnamed". */
function Named({ icon, name, title }: { icon: ReactNode; name: string | null; title?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      {icon}
      {name ?? <span className="italic text-text-dim">unnamed</span>}
    </span>
  );
}

// ─── Table properties ────────────────────────────────────────────────────────

/**
 * DBGate's Table properties: a new table's schema (Postgres) and name, and on MySQL the storage
 * engine and the table's comment. An existing table is renamed from the tree, not here.
 */
function TableProperties({ model, dbType, dialect, editable, isNew, schemas, onChange }: {
  model: TableModel;
  dbType: DbType;
  dialect: DialectName;
  editable: boolean;
  isNew: boolean;
  schemas: readonly string[] | null;
  onChange: ModelChange;
}) {
  const mysql = dialect === "mysql";
  if (!isNew && !mysql) return null;
  const off = !editable;
  const schemaChoices = schemas && model.schema && !schemas.includes(model.schema) ? [model.schema, ...schemas] : schemas;
  return (
    <section aria-label="Table properties" className="grid gap-2">
      <h3 className="ml-0.5 text-[12.5px] font-semibold text-text-primary">Table properties</h3>
      <div className="grid max-w-3xl grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3 rounded-md border border-border bg-panel-2 p-3">
        {isNew && dialect === "postgres" && (
          <Field label="Schema" htmlFor="table-prop-schema">
            {schemaChoices ? (
              <SelectInput id="table-prop-schema" value={model.schema ?? ""} disabled={off} onChange={(e) => onChange((m) => withTableName(m, { schema: e.target.value || null }))}>
                {schemaChoices.map((s) => <option key={s} value={s}>{s}</option>)}
              </SelectInput>
            ) : (
              <TextInput id="table-prop-schema" value={model.schema ?? ""} disabled={off} mono onChange={(e) => onChange((m) => withTableName(m, { schema: e.target.value || null }))} />
            )}
          </Field>
        )}
        {isNew && (
          <Field label="Table name" htmlFor="table-prop-name">
            <TextInput id="table-prop-name" value={model.name} disabled={off} mono onChange={(e) => onChange((m) => withTableName(m, { name: e.target.value }))} />
          </Field>
        )}
        {mysql && (
          <Field label="Engine" htmlFor="table-prop-engine">
            <TextWithList
              id="table-prop-engine" value={model.engine ?? ""} options={enginesFor(dbType)} disabled={off} listLabel="Choose an engine"
              onChange={(v) => onChange((m) => ({ ...m, engine: v.trim() === "" ? null : v }))}
            />
          </Field>
        )}
        {mysql && (
          <Field label="Comment" htmlFor="table-prop-comment">
            <TextInput id="table-prop-comment" value={model.comment ?? ""} disabled={off} onChange={(e) => onChange((m) => ({ ...m, comment: e.target.value === "" ? null : e.target.value }))} />
          </Field>
        )}
      </div>
    </section>
  );
}

// ─── Columns ─────────────────────────────────────────────────────────────────

function ColumnsSection({ model, dialect, editable, onChange, openDialog, collapsed, onToggle }: {
  model: TableModel;
  dialect: DialectName;
  editable: boolean;
  onChange: ModelChange;
  openDialog: (dialog: EditorDialogState) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const rows = useMemo(() => editorColumnRows(model), [model]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  // Where a drag across rows started; cleared when the button comes up anywhere.
  const dragFrom = useRef<number | null>(null);

  // A column removed or gone after a reload leaves the selection.
  useEffect(() => {
    setSelected((s) => (Array.from(s).every((id) => rows.some((r) => r.id === id)) ? s : new Set(Array.from(s).filter((id) => rows.some((r) => r.id === id)))));
  }, [rows]);
  useEffect(() => {
    const up = () => { dragFrom.current = null; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const range = (a: number, b: number) => new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.id));

  const mouseDown = (index: number, e: MouseEvent) => {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
    dragFrom.current = index;
  };
  const mouseEnter = (index: number, e: MouseEvent) => {
    if (dragFrom.current === null || (e.buttons & 1) === 0 || index === dragFrom.current) return;
    setSelected(range(dragFrom.current, index));
    setAnchor(rows[dragFrom.current]!.id);
  };
  const click = (id: string, index: number, e: MouseEvent) => {
    if (e.shiftKey && anchor) {
      setSelected(range(rows.findIndex((r) => r.id === anchor), index));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelected(next);
      setAnchor(id);
      return;
    }
    setSelected(new Set([id]));
    setAnchor(id);
    openDialog({ kind: "column", id });
  };
  const keyDown = (id: string, e: KeyboardEvent) => {
    if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); setSelected(new Set([id])); setAnchor(id); openDialog({ kind: "column", id }); }
  };

  const removeSelected = (ids: ReadonlySet<string>) => {
    onChange((m) => removeColumns(m, Array.from(ids)));
    setSelected(new Set());
  };

  // The row menu acts on the selection when it opened on a selected row, else on that row alone.
  const targetsOf = (id: string): ReadonlySet<string> => (selected.has(id) ? selected : new Set([id]));
  const menuFor = (key: string | null): MenuEntry[] | null => {
    if (!key || !rows.some((r) => r.id === key)) return null;
    const ids = targetsOf(key);
    return [
      { kind: "item", label: "Copy names", icon: Copy, onSelect: () => void copy(modelColumnNames(model, ids)) },
      { kind: "item", label: "Copy definitions", icon: Copy, onSelect: () => void copy(modelColumnDefinitions(model, ids, dialect)) },
    ];
  };
  const menu = useRowMenu(menuFor, (key) => {
    if (!selected.has(key)) { setSelected(new Set([key])); setAnchor(key); }
  });

  const n = selected.size;
  const actions = n > 0 && (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {editable && <SelectionAction onClick={() => removeSelected(selected)}>Remove ({n})</SelectionAction>}
      <SelectionAction onClick={() => void copy(modelColumnNames(model, selected))}>Copy names ({n})</SelectionAction>
      <SelectionAction onClick={() => void copy(modelColumnDefinitions(model, selected, dialect))}>Copy definitions ({n})</SelectionAction>
    </span>
  );
  const mysql = dialect === "mysql";

  return (
    <EditorSection
      title={`Columns (${rows.length})`}
      collapsed={collapsed}
      onToggle={onToggle}
      onAddNew={editable ? () => openDialog({ kind: "column", id: null }) : undefined}
      actions={actions}
      empty={rows.length === 0 ? "No columns defined" : null}
      head={[
        "", "Name", "Nullability", "Data type", "Default value", "Computed Expression", "Comment",
        ...(mysql ? ["Unsigned", "Zero fill"] : []), ...(editable ? [""] : []),
      ]}
      // One menu for the whole list, resolved from the row the gesture landed on (`data-row-key`).
      wrapBox={(box) => (
        <ContextMenu>
          <ContextMenuTrigger asChild>{cloneElement(box, menu.listProps)}</ContextMenuTrigger>
          {menu.entries && <RowMenuContent entries={menu.entries} />}
        </ContextMenu>
      )}
    >
      {rows.map((r, i) => (
        <tr
          key={r.id}
          data-row-key={r.id}
          tabIndex={0}
          aria-selected={selected.has(r.id)}
          aria-label={`Column ${r.name}`}
          onMouseDown={(e) => mouseDown(i, e)}
          onMouseEnter={(e) => mouseEnter(i, e)}
          onClick={(e) => click(r.id, i, e)}
          onKeyDown={(e) => keyDown(r.id, e)}
          className={cn(ROW, "cursor-pointer select-none outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring", selected.has(r.id) && "bg-accent-wash can-hover:hover:bg-accent-wash")}
        >
          <td className={cn(CELL, "w-9 font-mono text-[11px] text-text-subtle")}>{r.ordinal}</td>
          <td className={CELL}>
            <span className="inline-flex items-center gap-1.5">
              {r.role === "pk" ? <Key className="size-[15px] shrink-0 text-warning" aria-label="Primary key" />
                : r.role === "fk" ? <Link className="size-[15px] shrink-0 text-info" aria-label="Foreign key" />
                : <span aria-hidden className="grid w-[15px] shrink-0 place-items-center"><span className="size-1 rounded-full bg-text-subtle opacity-60" /></span>}
              <span className={r.notNull ? "font-semibold" : "font-normal"}>{r.name}</span>
            </span>
          </td>
          <td className={CELL}>{r.notNull ? "NOT NULL" : "NULL"}</td>
          <td className={cn(CELL, MONO)}>{r.type}</td>
          <td className={cn(CELL, MONO)}>{r.defaultValue}</td>
          <td className={cn(CELL, MONO)}>{r.computedExpression}</td>
          <td className={CELL}>{r.comment}</td>
          {mysql && <td className={CELL}>{r.unsigned ? "YES" : "NO"}</td>}
          {mysql && <td className={CELL}>{r.zerofill ? "YES" : "NO"}</td>}
          {editable && (
            <RemoveCell
              onRemove={() => {
                onChange((m) => removeColumns(m, [r.id]));
                setSelected((s) => { const next = new Set(s); next.delete(r.id); return next; });
              }}
            />
          )}
        </tr>
      ))}
    </EditorSection>
  );
}

function SelectionAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="rounded px-1 text-xs text-primary underline-offset-2 can-hover:hover:underline">
      {children}
    </button>
  );
}

async function copy(text: string): Promise<void> {
  if (await copyToClipboard(text)) toast.success("Copied");
  else toast.error("The clipboard is not available here");
}
