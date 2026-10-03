/**
 * DBGate's table structure tab. On a desktop it is DBGate's table editor (`TableEditor`): a
 * table's columns, keys, indexes and the keys of other tables that point at it, each section
 * changed in place and saved through Save changes — and, for New table, the table still to be
 * created. On a phone it only shows the table, one section each, a section left out when it has
 * nothing: changing a table's structure is a desktop tool.
 */
import { cloneElement, useMemo, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { toast } from "sonner";
import { CheckCircle, Code, Copy, Info, Key, Link, ListOrdered, Plus, RotateCcw, Save, Table } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { targetLabel } from "@/lib/db-tabs";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTabStore } from "@/stores/tab-store";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import type { DbObjectKind, DbObjectList, DbTableStructure } from "../../../../shared/db-structure";
import { useDbTab } from "../use-db-tab";
import { useDbRead } from "../use-db-read";
import { RowMenuContent, type MenuEntry } from "../explorer/explorer-menu";
import { useRowMenu } from "../explorer/use-row-menu";
import { openSqlTab, openTableTab, type DbRelation } from "../explorer/open-db-tabs";
import { DbTabHeader, DbTabState, DbToolButton, DbToolbar } from "../db-tab-parts";
import { TableEditor } from "../table-editor/table-editor";
import { TableEditorDialogs } from "../table-editor/table-editor-dialogs";
import { useTableEditorTab } from "../table-editor/use-table-editor-tab";
import {
  columnDefinitions, columnNames, columnRows, foreignKeyRow, ownIndexes, type ForeignKeyRow, type StructureColumnRow,
} from "./structure-model";

interface Props { metadata?: Record<string, unknown>; tabId?: string }

const SAVE_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘S" : "Ctrl+S";

export function StructureTab({ metadata, tabId }: Props) {
  const tab = useDbTab(metadata, tabId);
  const mobile = useIsMobile();
  const tableName = typeof metadata?.tableName === "string" ? metadata.tableName : "";
  const schemaName = typeof metadata?.schemaName === "string" ? metadata.schemaName : "";
  const objectKind = metadata?.objectKind as DbObjectKind | undefined;
  // A New table's tab names no table: it has nothing to read until its Save creates one.
  const path = tableName ? `/structure?table=${encodeURIComponent(tableName)}${schemaName ? `&schema=${encodeURIComponent(schemaName)}` : ""}` : null;
  const read = useDbRead<DbTableStructure>(tab.missing ? null : tab.target, path, tabId);
  const s = read.data;
  const editor = useTableEditorTab({ tabId, metadata, tab, live: s, reload: read.reload, mobile });
  const dialect = tab.dialect ?? "postgres";
  // A new table's schema is chosen from those the database has (Postgres).
  const schemas = useDbRead<DbObjectList>(editor.isNew && editor.editable && dialect === "postgres" ? tab.target : null, "/objects", tabId);

  const table = editor.isNew ? editor.model?.name ?? "" : tableName;
  const rel: DbRelation = { schema: schemaName || null, name: tableName, ...(objectKind ? { kind: objectKind } : {}) };
  const openData = () => { if (tab.place) openTableTab(tab.place, rel); };
  const openSql = () => { if (tab.place) openSqlTab(tab.place, { schema: rel.schema, name: tableName, kind: objectKind ?? "table" }); };
  const close = tabId ? () => useTabStore.getState().closeTab(tabId) : undefined;
  const { model, editable } = editor;

  if (tab.missing) return <DbTabState empty="This connection no longer exists." />;

  // What a phone cannot do here is said rather than lost: the change stays in the tab for a desktop.
  const notice = mobile && editor.isNew
    ? "This table is not created yet. Open this tab on a larger screen to set it up and create it."
    : mobile && editor.dirty
      ? "This tab holds changes to the table that are not saved. Open it on a larger screen to review and save them."
      : null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <DbTabHeader
        title={table}
        subtitle={[targetLabel(tab.target, tab.name), editor.isNew ? model?.schema ?? "" : schemaName, "structure"].filter(Boolean).join(" · ")}
        color={tab.conn?.color ?? (metadata?.connectionColor as string | undefined)}
        onClose={close}
      />
      {!(mobile && editor.isNew) && (
        <DbToolbar label={`${table} structure`}>
          {!editor.isNew && (
            <>
              <DbToolButton icon={Table} label="Data" title={`Open the data of ${table}`} onClick={openData} opensTab disabled={!tab.place} />
              <DbToolButton icon={Code} label="SQL" title={`Open the SQL of ${table} in its own tab`} onClick={openSql} opensTab disabled={!tab.place} />
            </>
          )}
          {editable && (
            <>
              <DbToolButton
                icon={Save} label={editor.isNew ? "Create table" : "Alter table"} title={`Save changes to the database (${SAVE_KEY})`}
                onClick={editor.save} disabled={!editor.canSave}
              />
              <DbToolButton icon={RotateCcw} label="Reset changes" onClick={editor.reset} disabled={!editor.dirty} />
              <DbToolButton icon={Plus} label="Add column" onClick={() => editor.openDialog({ kind: "column", id: null })} />
              <DbToolButton
                icon={ListOrdered} label="Add index" onClick={() => editor.openDialog({ kind: "key", keyKind: "index", id: null })}
                disabled={!model || model.columns.length === 0}
              />
            </>
          )}
        </DbToolbar>
      )}
      {notice && (
        <p role="status" className="flex shrink-0 items-start gap-2 border-b border-border-soft bg-panel-2 px-3 py-2.5 text-[13px] text-text-2">
          <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
          {notice}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {!mobile && model && tab.dbType ? (
          <TableEditor
            model={model} dialect={dialect} dbType={tab.dbType} editable={editable} isNew={editor.isNew}
            references={s?.references ?? []} schemas={schemas.data?.schemas ?? null}
            onChange={editor.change} openDialog={editor.openDialog}
          />
        ) : s ? (
          <StructureSections s={s} dialect={dialect} />
        ) : !(mobile && editor.isNew) && (
          <DbTabState loading={read.loading || (!read.error && !read.driver)} error={read.error} driver={read.driver} />
        )}
      </div>
      {!mobile && model && tab.target && (
        <TableEditorDialogs
          dialog={editor.dialog} model={model} dialect={dialect} target={tab.target} editable={editable}
          onChange={editor.change} onClose={editor.closeDialog}
        />
      )}
    </div>
  );
}

function StructureSections({ s, dialect }: { s: DbTableStructure; dialect: "postgres" | "mysql" | "sqlite" }) {
  const columns = useMemo(() => columnRows(s), [s]);
  const indexes = useMemo(() => ownIndexes(s), [s]);
  const fks = useMemo(() => s.foreignKeys.map((fk) => foreignKeyRow(fk, s.schema)), [s]);
  const deps = useMemo(() => s.references.map((fk) => foreignKeyRow(fk, s.schema)), [s]);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-[18px] px-[18px] pt-3.5 pb-7 max-md:gap-3.5 max-md:p-3">
      <ColumnsSection s={s} rows={columns} dialect={dialect} />
      {s.primaryKey && (
        <Section title="Primary key" head={["Name", "Columns"]}>
          <tr className={ROW}>
            <td className={CELL}><Named icon={<Key className="size-[15px] shrink-0 text-warning" aria-hidden />} name={s.primaryKey.name} /></td>
            <td className={CELL}>{s.primaryKey.columns.join(", ")}</td>
          </tr>
        </Section>
      )}
      {indexes.length > 0 && (
        <Section title={`Indexes (${indexes.length})`} head={["Name", "Columns", "Unique"]}>
          {indexes.map((ix) => (
            <tr key={ix.name} className={ROW}>
              <td className={CELL}><Named icon={<ListOrdered className="size-[15px] shrink-0 text-text-subtle" aria-hidden />} name={ix.name} /></td>
              <td className={CELL}>{ix.columns.join(", ")}</td>
              <td className={CELL}>{ix.unique ? "YES" : "NO"}</td>
            </tr>
          ))}
        </Section>
      )}
      {s.uniques.length > 0 && (
        <Section title={`Unique constraints (${s.uniques.length})`} head={["Name", "Columns"]}>
          {s.uniques.map((u, i) => (
            <tr key={u.name ?? `#${i}`} className={ROW}>
              <td className={CELL}><Named icon={<CheckCircle className="size-[15px] shrink-0 text-text-subtle" aria-hidden />} name={u.name} /></td>
              <td className={CELL}>{u.columns.join(", ")}</td>
            </tr>
          ))}
        </Section>
      )}
      {fks.length > 0 && <ForeignKeySection title={`Foreign keys (${fks.length})`} rows={fks} />}
      {deps.length > 0 && <ForeignKeySection title={`Dependencies (${deps.length})`} rows={deps} dependencies />}
    </div>
  );
}

const ROW = "can-hover:hover:bg-surface-hover";
const CELL = "whitespace-nowrap border-b border-border-soft px-2.5 py-1.5 max-md:p-2.5";
const MONO = "font-mono text-[11.5px]";

function Section({ title, head, children, wrapBox }: {
  title: string;
  head: string[];
  children: ReactNode;
  /** Wraps the table's box, e.g. in the trigger of a menu for its rows. */
  wrapBox?: (box: ReactElement) => ReactNode;
}) {
  const box = (
    <div className="overflow-x-auto rounded-md border border-border bg-panel-2">
      <table className="w-full border-collapse text-[12.5px] max-md:text-[13px]">
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
      <h3 className="mb-1.5 ml-0.5 text-[12.5px] font-semibold text-text-primary">{title}</h3>
      {wrapBox ? wrapBox(box) : box}
    </section>
  );
}

/** A name, or — SQLite names no key or constraint — a dimmed "unnamed". */
function Named({ icon, name, title }: { icon: ReactNode; name: string | null; title?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      {icon}
      {name ?? <span className="italic text-text-dim">unnamed</span>}
    </span>
  );
}

const FK_HEAD = ["Name", "Base columns", "Referenced table", "Referenced columns", "ON UPDATE", "ON DELETE"];

function ForeignKeySection({ title, rows, dependencies }: { title: string; rows: ForeignKeyRow[]; dependencies?: boolean }) {
  return (
    <Section title={title} head={FK_HEAD}>
      {rows.map((fk, i) => (
        <tr key={`${fk.holder}\u0000${fk.name ?? i}`} className={ROW}>
          <td className={CELL}>
            <Named
              icon={<Link className="size-[15px] shrink-0 text-info" aria-hidden />}
              name={fk.name}
              // DBGate's columns say nothing of which table holds a dependency's key.
              title={dependencies ? `${fk.holder} (${fk.baseColumns}) → ${fk.refTable} (${fk.refColumns})` : undefined}
            />
          </td>
          <td className={CELL}>{fk.baseColumns}</td>
          <td className={CELL}>{fk.refTable}</td>
          <td className={CELL}>{fk.refColumns}</td>
          <td className={CELL}>{fk.onUpdate}</td>
          <td className={CELL}>{fk.onDelete}</td>
        </tr>
      ))}
    </Section>
  );
}

/**
 * The Columns section: DBGate's list, with its menu — Copy names, Copy definitions — acting on the
 * selected rows, or on the row it opened on when that one is not selected. A click selects one row,
 * Ctrl/⌘ adds or removes one, Shift a range.
 */
function ColumnsSection({ s, rows, dialect }: { s: DbTableStructure; rows: StructureColumnRow[]; dialect: "postgres" | "mysql" | "sqlite" }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  const click = (name: string, e: MouseEvent) => {
    if (e.shiftKey && anchor) {
      const a = rows.findIndex((r) => r.name === anchor);
      const b = rows.findIndex((r) => r.name === name);
      const [from, to] = a < b ? [a, b] : [b, a];
      setSelected(new Set(rows.slice(from, to + 1).map((r) => r.name)));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      setSelected(next);
    } else {
      setSelected(new Set([name]));
    }
    setAnchor(name);
  };

  // What the menu acts on: the selection when it opened on a selected row, else that row alone.
  const targetsOf = (name: string) => (selected.has(name) ? rows.filter((r) => selected.has(r.name)).map((r) => r.name) : [name]);
  const menuFor = (key: string | null): MenuEntry[] | null => {
    if (!key || !rows.some((r) => r.name === key)) return null;
    const names = targetsOf(key);
    const defs = s.columns.filter((c) => names.includes(c.name));
    return [
      { kind: "item", label: "Copy names", icon: Copy, onSelect: () => void copy(columnNames(names)) },
      { kind: "item", label: "Copy definitions", icon: Copy, onSelect: () => void copy(columnDefinitions(defs, dialect)) },
    ];
  };
  const menu = useRowMenu(menuFor, (key) => {
    if (!selected.has(key)) { setSelected(new Set([key])); setAnchor(key); }
  });

  return (
    <Section
      title={`Columns (${rows.length})`}
      head={["", "Name", "Nullability", "Data type", "Default value", "Computed Expression", "Comment"]}
      // One menu for the whole list, resolved from the row the gesture landed on (`data-row-key`).
      wrapBox={(box) => (
        <ContextMenu>
          <ContextMenuTrigger asChild>{cloneElement(box, menu.listProps)}</ContextMenuTrigger>
          {menu.entries && <RowMenuContent entries={menu.entries} />}
        </ContextMenu>
      )}
    >
      {rows.map((r) => (
        <tr
          key={r.name}
          data-row-key={r.name}
          aria-selected={selected.has(r.name)}
          onClick={(e) => click(r.name, e)}
          className={cn(ROW, "cursor-default select-none", selected.has(r.name) && "bg-accent-wash can-hover:hover:bg-accent-wash")}
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
        </tr>
      ))}
    </Section>
  );
}

async function copy(text: string): Promise<void> {
  if (await copyToClipboard(text)) toast.success("Copied");
  else toast.error("The clipboard is not available here");
}
