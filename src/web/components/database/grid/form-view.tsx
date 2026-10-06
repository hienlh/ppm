/**
 * DBGate's Form view: one row of the table, a field per column, top to bottom and then in a new
 * pair of columns to the right once the height runs out, so the form only ever scrolls sideways.
 * The row is the grid's current row and every edit goes into the grid's change set, so F4 back to
 * the table shows it there. The keys are DBGate's: arrows move between names and values, Enter or
 * F2 — or a letter typed — edits a value, a letter typed on a name adds to the Column name filter,
 * and ⊞ on a foreign key shows the referenced row's columns under it.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { toast } from "sonner";
import { GridCellKind } from "@glideapps/glide-data-grid";
import { Form, Loader2, SquareMinus, SquarePlus } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { formatCellValue, type GridColumnSchema, type RowCountView } from "../glide-grid-types";
import { dbTypeToKind } from "../use-glide-cell-content";
import { ColumnIcon } from "./columns-panel";
import { isBinaryValue } from "./cell-display";
import { rowChange } from "./change-marks";
import { cellId, isNewRowId, type CellChange, type GridChangeset } from "./grid-changeset";
import { GridCornerLabel } from "./grid-status-bar";
import { valueKey } from "./value-filter-text";
import {
  FORM_ROW_HEIGHT, cellOfField, columnNameMatches, fieldOfCell, fieldsPerColumn, formChunks, formCopyText, formDisplayText,
  formEditText, formRowLabel, isValueCell, moveFormCell, parseFormText, type FormCell, type FormFieldKind, type FormNavigation,
} from "./form-view-model";

/** The row a foreign key refers to, as ⊞ shows it: its columns bar the key, and its values — none when no row has that key. */
export interface ReferencedRow {
  columns: readonly GridColumnSchema[];
  row: Record<string, unknown> | null;
}

/** One line of the form: a column of the table, or — under an expanded foreign key — of the row it refers to. */
interface FormField {
  key: string;
  column: GridColumnSchema;
  /** The foreign key this line was expanded from: read-only, its value the referenced row's. */
  parent?: string;
}

/**
 * Where the form's cursor is, by field rather than by cell, so a new height keeps it on the same
 * field — and by the field's key rather than its place, so a foreign key's lines opening or closing
 * above it leave it there.
 */
interface FormCursor {
  field: string;
  /** The foreign key a line under one was expanded from: where the cursor goes when the line closes. */
  parent?: string;
  onName: boolean;
}

/** What the form's menu acts on: the field under the cursor, and the row's value in it. */
export interface FormMenuTarget {
  /** The field's column: under an expanded foreign key, the referenced table's. */
  column: string;
  /** A line under an expanded foreign key: the referenced row's, which nothing here changes or filters by. */
  referenced: boolean;
  onName: boolean;
  value: unknown;
}

export interface FormViewProps {
  table?: string | null;
  /** The row shown — the grid's current row — and where it is among the grid's rows. */
  row: Record<string, unknown> | undefined;
  index: number;
  /** Every row the grid holds, new ones included, and how many of them were read from the table. */
  rowsShown: number;
  loaded: number;
  rowCount: RowCountView | null;
  /** Every column of the table, in its order: the form shows the ones the grid hides too, as DBGate's does. */
  schema: readonly GridColumnSchema[];
  /** The column naming each row in the change set; none where rows cannot be addressed. */
  pkCol: string | null;
  changeset: GridChangeset;
  canEdit: (row: Record<string, unknown>, column: string) => boolean;
  onEdit: (changes: CellChange[]) => void;
  /** The column the cursor starts on: the one the grid's cursor was on. */
  initialField: string | null;
  /** The cursor moved to another column of the table, which the grid's cursor follows. */
  onFieldChange: (column: string) => void;
  nameFilter: string;
  /** Absent where the name filter is not kept: a letter typed on a name then does nothing. */
  onNameFilterChange?: (text: string) => void;
  onNavigate: (to: FormNavigation) => void;
  /** DBGate's Filter this value (Ctrl+Shift+F): the column's filter set to the value. */
  onFilterValue?: (column: string, value: unknown) => void;
  /** Save, once what the editor holds has gone into the change set. */
  onSave: () => void;
  onMenu: (position: { x: number; y: number }, target: FormMenuTarget) => void;
  /** ⊞: the row a foreign key's value refers to. Absent where no other table can be read. */
  loadReference?: (column: string, row: Record<string, unknown>) => Promise<ReferencedRow>;
  /** The form icon in a foreign key's value: the referenced row as a form, in a new tab. */
  onOpenReference?: (column: string, row: Record<string, unknown>) => void;
  /** Focused when it appears: the user switched to it, rather than the tab reopening on it. */
  autoFocus?: boolean;
}

/** How a column's editor reads what is typed: the Cell data view's editors read it the same way. */
export const fieldKind = (col: GridColumnSchema): FormFieldKind => {
  const kind = dbTypeToKind(col.type);
  return kind === GridCellKind.Number ? "number" : kind === GridCellKind.Boolean ? "boolean" : "text";
};

/** DBGate's keys that type into the form: letters, digits and the dash. */
const TYPED_KEY = /^[a-z0-9-]$/i;

/** The referenced row of `column` for the values it holds now, as the cache keys it. */
const referenceKey = (column: string, value: unknown) => `${column}\u0000${valueKey(value)}`;

export function FormView(p: FormViewProps) {
  const id = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    // The box's own height, scrollbar included, so a scrollbar coming and going cannot change how
    // many fields a pair holds — and the scrollbar with them.
    const measure = () => setHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (p.autoFocus) boxRef.current?.focus({ preventScroll: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const row = p.row;
  // Rows that cannot be addressed hold no change: no id is looked up for them.
  const rowId = row && p.pkCol ? String(row[p.pkCol]) : "";
  const isNew = isNewRowId(rowId);
  const change = rowId ? rowChange(p.changeset, rowId) : null;
  /** What a column of the row holds now: its edit's value, and on a new row only what was put in it. */
  const valueOf = useCallback((column: string): unknown => {
    if (!row) return undefined;
    const pending = rowId ? p.changeset.cells.get(cellId(rowId, column)) : undefined;
    if (pending) return pending.newVal;
    return isNew ? undefined : row[column];
  }, [row, rowId, isNew, p.changeset]);
  // The row as it reads now, for what a foreign key refers to.
  const shownRow = useMemo(() => (row ? Object.fromEntries(p.schema.map((c) => [c.name, valueOf(c.name)])) : undefined), [row, p.schema, valueOf]);

  // ── ⊞: the referenced row's columns under its foreign key ──
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [references, setReferences] = useState<ReadonlyMap<string, ReferencedRow | "loading">>(() => new Map());
  // Read again for every row shown, and when the rows are read again: the referenced row may have changed.
  useEffect(() => setReferences(new Map()), [row]);
  const loadReference = p.loadReference;
  useEffect(() => {
    if (!loadReference || !shownRow) return;
    for (const column of expanded) {
      const key = referenceKey(column, shownRow[column]);
      if (references.has(key)) continue;
      setReferences((m) => new Map(m).set(key, "loading"));
      loadReference(column, shownRow).then(
        (read) => setReferences((m) => new Map(m).set(key, read)),
        (e: Error) => {
          toast.error(`Could not read the row ${column} refers to`, { description: e.message });
          setReferences((m) => { const next = new Map(m); next.delete(key); return next; });
          setExpanded((s) => { const next = new Set(s); next.delete(column); return next; });
        },
      );
    }
  }, [expanded, shownRow, references, loadReference]);

  const fields = useMemo<FormField[]>(() => p.schema.flatMap((column): FormField[] => {
    const own: FormField = { key: column.name, column };
    if (!column.fk || !expanded.has(column.name) || !shownRow) return [own];
    const read = references.get(referenceKey(column.name, shownRow[column.name]));
    if (!read || read === "loading") return [own];
    return [own, ...read.columns.map((c) => ({ key: `${column.name}.${c.name}`, column: c, parent: column.name }))];
  }), [p.schema, expanded, references, shownRow]);
  const fieldValue = (f: FormField): unknown => {
    if (!f.parent) return valueOf(f.column.name);
    const read = shownRow && references.get(referenceKey(f.parent, shownRow[f.parent]));
    return read && read !== "loading" ? read.row?.[f.column.name] ?? null : null;
  };

  // ── The cursor ──
  const per = fieldsPerColumn(height || FORM_ROW_HEIGHT * 12);
  const [cursor, setCursor] = useState<FormCursor>(() => ({ field: p.initialField ?? "", onName: false }));
  const found = fields.findIndex((f) => f.key === cursor.field);
  const at = found >= 0 ? found : Math.max(0, fields.findIndex((f) => f.key === cursor.parent));
  const cursorOn = (field: number, onName: boolean): FormCursor => ({ field: fields[field]?.key ?? "", parent: fields[field]?.parent, onName });
  const current = fields[at];
  const cell = cellOfField(at, per, cursor.onName);
  const onFieldChange = p.onFieldChange;
  useEffect(() => {
    if (current && !current.parent) onFieldChange(current.column.name);
  }, [current, onFieldChange]);
  const moveTo = (next: FormCell) => setCursor(cursorOn(Math.min(fieldOfCell(next, per), fields.length - 1), !isValueCell(next)));
  const domId = (field: number, onName: boolean) => `${id}-${field}-${onName ? "n" : "v"}`;
  // The cursor's cell kept in view, as DBGate scrolls it into view.
  useEffect(() => {
    document.getElementById(domId(at, cursor.onName))?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [at, cursor.onName, per]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Editing a value ──
  const [editing, setEditing] = useState<{ text: string; selectAll: boolean } | null>(null);
  // Another row, or another field: an editor left open would put its value into the wrong place.
  useEffect(() => setEditing(null), [p.index, cursor.field]);
  // A value that can change at all — set to NULL, say — and one that can also be typed: not bytes.
  const changeable = (f: FormField | undefined): f is FormField => !!f && !!row && !f.parent && p.canEdit(row, f.column.name);
  const editable = (f: FormField | undefined): f is FormField => changeable(f) && !isBinaryValue(valueOf(f.column.name));
  const startEdit = (text?: string) => {
    if (!editable(current)) return;
    setEditing(text === undefined ? { text: formEditText(valueOf(current.column.name)), selectAll: true } : { text, selectAll: false });
  };
  const putValue = (f: FormField, value: unknown) => {
    if (!row || Object.is(value, valueOf(f.column.name) ?? null)) return;
    p.onEdit([{ row, column: f.column.name, value }]);
  };
  const toggleExpanded = (f: FormField | undefined, open: boolean) => {
    if (!f?.column.fk || f.parent || !loadReference) return;
    setExpanded((s) => {
      if (s.has(f.column.name) === open) return s;
      const next = new Set(s);
      if (open) next.add(f.column.name);
      else next.delete(f.column.name);
      return next;
    });
  };

  const copy = () => {
    if (!current) return;
    const text = cursor.onName ? current.column.name : formCopyText(fieldValue(current));
    void copyToClipboard(text).then((ok) => { if (!ok) toast.error("Could not copy to the clipboard"); });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The editor's keys are its own.
    if (editing || e.target !== e.currentTarget || e.nativeEvent.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && !e.shiftKey && !e.altKey) {
      const to = ({ Home: "first", ArrowUp: "previous", ArrowDown: "next", End: "last" } as const)[e.key as "Home"];
      if (to) { done(); p.onNavigate(to); return; }
      if (e.key.toLowerCase() === "c" && (window.getSelection()?.isCollapsed ?? true)) { done(); copy(); return; }
      if (e.key === "0") {
        done();
        if (!cursor.onName && changeable(current)) putValue(current, null);
        return;
      }
    }
    if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f" && p.onFilterValue) {
      done();
      if (current && !current.parent) p.onFilterValue(current.column.name, fieldValue(current));
      return;
    }
    // Before the typed keys: NumPad − is a dash too.
    if (e.code === "NumpadAdd" || e.code === "NumpadSubtract") { done(); toggleExpanded(current, e.code === "NumpadAdd"); return; }
    if (!mod && !e.altKey && TYPED_KEY.test(e.key)) {
      done();
      if (cursor.onName) p.onNameFilterChange?.(p.nameFilter + e.key);
      else startEdit(e.key);
      return;
    }
    if (e.key === "Escape" && p.nameFilter && p.onNameFilterChange) { done(); p.onNameFilterChange(""); return; }
    if ((e.key === "Enter" || e.key === "F2") && !mod) {
      if (!cursor.onName) { done(); startEdit(); }
      return;
    }
    const next = moveFormCell(cell, e.key, mod, {
      fieldCount: fields.length, perColumn: per, nameFilter: p.nameFilter, names: fields.map((f) => f.column.name),
    });
    if (next) { done(); moveTo(next); }
  };

  const onCellMouseDown = (e: MouseEvent, field: number, onName: boolean) => {
    if (e.button !== 0) return;
    const onCurrentValue = !onName && !cursor.onName && field === at;
    // The editor's own cell: a click there is the editor's, and must not take its focus away.
    if (onCurrentValue && editing) return;
    // A click on the value the cursor is on already edits it, as in DBGate.
    if (onCurrentValue) {
      e.preventDefault();
      startEdit();
      return;
    }
    setCursor(cursorOn(field, onName));
  };
  /** A button in a cell: the cursor stays, and the form keeps its keys. */
  const buttonMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    boxRef.current?.focus({ preventScroll: true });
  };
  const onCellContextMenu = (e: MouseEvent, field: number, onName: boolean) => {
    e.preventDefault();
    const f = fields[field];
    if (!f) return;
    setCursor(cursorOn(field, onName));
    p.onMenu({ x: e.clientX, y: e.clientY }, { column: f.column.name, referenced: !!f.parent, onName, value: fieldValue(f) });
  };

  const label = formRowLabel(p.index, p.rowsShown, p.loaded, p.rowCount);
  if (!row) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={boxRef} tabIndex={0} className="min-h-0 flex-1 outline-none" />
        <GridCornerLabel text={label} right={16} bottom={12} />
      </div>
    );
  }

  const chunks = formChunks(fields.map((f, i) => [f, i] as const), per);
  const nameFilter = p.nameFilter.trim();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={boxRef} tabIndex={0} role="grid" aria-label={`${p.table ?? "Row"} as a form`} data-form-view=""
        aria-activedescendant={domId(at, cursor.onName)} onKeyDown={onKeyDown}
        className="group/form flex min-h-0 flex-1 items-start overflow-auto outline-none"
      >
        {chunks.map((chunk, pair) => (
          <table key={pair} role="rowgroup" className="flex-none border-separate border-spacing-0 border-r border-border text-[12.5px]">
            <tbody>
              {chunk.map(([f, i]) => {
                const value = fieldValue(f);
                const edited = !f.parent && !isNew && !!rowId && p.changeset.cells.has(cellId(rowId, f.column.name));
                const here = i === at;
                const hit = !!nameFilter && columnNameMatches(nameFilter, f.column.name);
                const fk = !f.parent && f.column.fk ? f.column.fk : null;
                const loading = fk && expanded.has(f.column.name) && references.get(referenceKey(f.column.name, shownRow?.[f.column.name])) === "loading";
                return (
                  <tr
                    key={f.key} role="row"
                    className={cn(change === "deleted" && "text-text-subtle line-through decoration-error/70", change === "inserted" && "bg-success/15")}
                  >
                    <td
                      id={domId(i, true)} role="rowheader" aria-selected={here && cursor.onName}
                      onMouseDown={(e) => onCellMouseDown(e, i, true)} onContextMenu={(e) => onCellContextMenu(e, i, true)}
                      className={cn(
                        "h-[30px] border-r border-b border-border-soft bg-panel px-2.5 text-text-2",
                        hit && "bg-warning/20",
                        here && "bg-accent-wash text-text",
                        change === "deleted" && "bg-error/10",
                      )}
                    >
                      <div className="flex min-w-[170px] max-w-[230px] items-center gap-[5px]" style={{ paddingLeft: f.parent ? 20 : 0 }}>
                        {fk && loadReference ? (
                          <button
                            type="button" tabIndex={-1} aria-expanded={expanded.has(f.column.name)} aria-busy={!!loading || undefined}
                            aria-label={`${expanded.has(f.column.name) ? "Collapse" : "Expand"} ${f.column.name}`}
                            title={`Show the ${fk.table} row's columns (NumPad + / −)`}
                            onMouseDown={buttonMouseDown}
                            onClick={() => toggleExpanded(f, !expanded.has(f.column.name))}
                            className="grid size-[18px] shrink-0 place-items-center rounded text-text-3 can-hover:hover:bg-surface-hover can-hover:hover:text-text"
                          >
                            {loading ? <Loader2 className="size-3 animate-spin" /> : expanded.has(f.column.name) ? <SquareMinus className="size-3.5" /> : <SquarePlus className="size-3.5" />}
                          </button>
                        ) : (
                          <span className="size-[18px] shrink-0" aria-hidden />
                        )}
                        <ColumnIcon col={f.column} className="size-3.5" />
                        {/* Bold is NOT NULL, as in the column list. */}
                        <span className={cn("min-w-0 truncate", !f.column.nullable && "font-semibold text-text")}>{f.column.name}</span>
                        {/* The type gives way first: a long one must not cut the name short. */}
                        <span className="min-w-0 flex-[1_1_0] truncate pl-1 text-right font-mono text-[10px] text-text-3">{f.column.type}</span>
                      </div>
                    </td>
                    <td
                      id={domId(i, false)} role="gridcell" aria-selected={here && !cursor.onName} aria-readonly={!editable(f) || undefined}
                      onMouseDown={(e) => onCellMouseDown(e, i, false)} onContextMenu={(e) => onCellContextMenu(e, i, false)}
                      title={edited ? `Was: ${formDisplayText(row[f.column.name] ?? null)}` : undefined}
                      className={cn(
                        "group/value relative h-[30px] cursor-cell border-b border-border-soft px-2.5",
                        f.parent && "bg-info/5 text-text-2",
                        edited && "bg-warning/15 shadow-[inset_2px_0_0_var(--color-warning)]",
                        change === "deleted" && "bg-error/10",
                        here && !cursor.onName && "shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--color-primary)_40%,transparent)] group-focus-within/form:shadow-[inset_0_0_0_2px_var(--color-primary)]",
                      )}
                    >
                      {here && !cursor.onName && editing ? (
                        <FieldEditor
                          key={`${p.index}:${f.key}`} column={f.column.name} kind={fieldKind(f.column)} initial={editing.text} selectAll={editing.selectAll}
                          unchanged={formEditText(value)}
                          onCommit={(next) => putValue(f, next)}
                          onClose={(refocus) => { setEditing(null); if (refocus) boxRef.current?.focus({ preventScroll: true }); }}
                          onDown={() => moveTo(cellOfField(Math.min(i + 1, fields.length - 1), per))}
                          onSave={p.onSave}
                        />
                      ) : (
                        <div className={cn("flex min-w-[220px] max-w-[400px] items-center gap-1", fk && "pr-6")}>
                          <FieldValue value={value} number={fieldKind(f.column) === "number"} />
                          {fk && value !== null && value !== undefined && p.onOpenReference && (
                            <button
                              type="button" tabIndex={-1} onMouseDown={buttonMouseDown}
                              onClick={() => shownRow && p.onOpenReference!(f.column.name, shownRow)}
                              aria-label={`Open the ${fk.table} row as a form`} title={`Open ${fk.table} ${fk.column} = ${formatCellValue(value)} as a form in a new tab`}
                              className={cn(
                                "absolute top-1/2 right-[3px] grid size-5 -translate-y-1/2 place-items-center rounded text-text-3 can-hover:hover:bg-accent-wash can-hover:hover:text-primary",
                                here ? "opacity-100" : "opacity-35 can-hover:group-hover/value:opacity-100",
                              )}
                            >
                              <Form className="size-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
      </div>
      <GridCornerLabel text={label} right={16} bottom={12} />
    </div>
  );
}

/** A value as the grid draws it: NULL faded and slanted, bytes dim, numbers in the numbers' face. */
function FieldValue({ value, number }: { value: unknown; number: boolean }) {
  const text = formDisplayText(value);
  if (value === null || value === undefined) return <span className="truncate text-text-3 italic">{text}</span>;
  if (isBinaryValue(value)) return <span className="truncate text-text-3">{text}</span>;
  return <span className={cn("min-w-0 truncate", number && "font-mono tabular-nums")}>{text}</span>;
}

/**
 * DBGate's editor in place of a value: Enter puts the value in and goes down a field, Tab puts it
 * in, Escape leaves it as it was. Leaving it any other way puts it in too — a click elsewhere, the
 * window losing focus — unless what was typed does not read as the column's type.
 */
function FieldEditor({ column, kind, initial, selectAll, unchanged, onCommit, onClose, onDown, onSave }: {
  column: string;
  kind: FormFieldKind;
  initial: string;
  selectAll: boolean;
  /** What the editor would hold had nothing been typed: left so, nothing goes in. */
  unchanged: string;
  onCommit: (value: unknown) => void;
  /** `refocus`: the editor was left by a key, so the form takes its keys again. */
  onClose: (refocus: boolean) => void;
  onDown: () => void;
  onSave: () => void;
}) {
  const [text, setText] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const closed = useRef(false);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (selectAll) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = parseFormText(text, kind);
  /** Puts the value in; false when what was typed cannot go in. */
  const commit = () => {
    if (text === unchanged) return true;
    if (!parsed.ok) return false;
    onCommit(parsed.value);
    return true;
  };
  const close = (refocus: boolean) => {
    closed.current = true;
    onClose(refocus);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === "Escape") { stop(); close(true); return; }
    if (e.key === "Enter" || e.key === "Tab") {
      stop();
      if (!commit()) return;
      close(true);
      if (e.key === "Enter") onDown();
      return;
    }
    if (mod && e.key.toLowerCase() === "s") {
      stop();
      if (!commit()) return;
      close(true);
      onSave();
    }
  };
  return (
    <input
      ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
      onBlur={() => {
        if (closed.current) return;
        if (!commit() && !parsed.ok) toast.error(`${column}: ${parsed.error}`, { description: "What was typed was not kept." });
        close(false);
      }}
      // The table view's keys leave this alone, as they leave the grid's own cell editor alone.
      data-cell-editor="" aria-label={`Edit ${column}`} aria-invalid={!parsed.ok || undefined}
      title={parsed.ok ? undefined : parsed.error}
      inputMode={kind === "number" ? "decimal" : undefined} autoComplete="off" autoCapitalize="off" spellCheck={false}
      className={cn(
        "block h-[29px] w-full min-w-[220px] max-w-[400px] bg-transparent text-[12.5px] text-text outline-none",
        kind === "number" && "font-mono",
        !parsed.ok && "text-error",
      )}
    />
  );
}
