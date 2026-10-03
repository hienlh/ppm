/**
 * How a phone changes a row: tapping a cell opens its row as a form in a bottom sheet, one field
 * per column the grid shows, top to bottom — DBGate's Form view laid out for a thumb (the mockup's
 * "a row as a form in a bottom sheet"). A field goes into the grid's change set when it is left,
 * one step of undo each, and an edited field of a saved row says what it was. Previous and Next
 * walk the rows the grid holds; Save writes every change through the Save changes dialog.
 *
 * Leaving a field is not a tap on a button: on iOS that leaves the keyboard's field focused. So a
 * field also goes in when the sheet moves to another row or closes, and Save puts in the field
 * being typed in itself — saving only once that has reached the change set, which it reads.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { GridCellKind } from "@glideapps/glide-data-grid";
import { ChevronLeft, ChevronRight, Save, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { inputClass } from "../connection-form/form-controls";
import { dbTypeToKind } from "../use-glide-cell-content";
import { formatCellValue, type GridColumnSchema } from "../glide-grid-types";
import { NO_FIELD_TEXT, NULL_TEXT, formatBinary, isBinaryValue } from "./cell-display";
import { cellId, isNewRowId, type CellChange, type GridChangeset } from "./grid-changeset";

export interface RowFormSheetProps {
  /** The table the rows were read from, which the title names. */
  table?: string | null;
  /** The grid's rows, new ones after the rows read. */
  rows: readonly Record<string, unknown>[];
  /** How many of `rows` were read from the table. */
  loaded: number;
  index: number;
  onIndexChange: (index: number) => void;
  /** The columns the grid shows, in its order. */
  columns: readonly string[];
  schema: ReadonlyMap<string, GridColumnSchema>;
  /** The column naming each row in the change set; none where rows cannot be addressed, nor changed. */
  pkCol: string | null;
  /** The columns of the row's key, which the title shows. */
  keyCols: readonly string[];
  changeset: GridChangeset;
  canEdit: (row: Record<string, unknown>, column: string) => boolean;
  onEdit: (changes: CellChange[]) => void;
  /** Rows Save would write. */
  pending: number;
  /** Absent where the grid cannot save. */
  onSave?: () => void;
  onClose: () => void;
}

export function RowFormSheet(p: RowFormSheetProps) {
  const titleId = useId();
  // The fields typed in and not put in yet, by column: false while one does not read as its type.
  const [drafts, setDrafts] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const onDraft = useCallback((column: string, valid: boolean | null) => setDrafts((d) => {
    if (d.get(column) === (valid ?? undefined)) return d;
    const next = new Map(d);
    if (valid === null) next.delete(column);
    else next.set(column, valid);
    return next;
  }), []);
  const [saveAsked, setSaveAsked] = useState(false);
  useEffect(() => {
    if (!saveAsked) return;
    setSaveAsked(false);
    // A field typed back to what it held put nothing in.
    if (p.pending > 0) p.onSave?.();
  }, [saveAsked, p.pending, p.onSave]);
  const save = () => {
    // Puts the field being typed in into the change set; the save waits for it to render there.
    (document.activeElement as HTMLElement | null)?.blur();
    setSaveAsked(true);
  };
  const row = p.rows[p.index];
  if (!row) return null;
  // Rows that cannot be addressed hold no change: no id is looked up for them.
  const rowId = p.pkCol ? String(row[p.pkCol]) : "";
  const isNew = isNewRowId(rowId);
  const deleted = p.changeset.deleted.has(rowId);
  const name = isNew ? "New row" : p.keyCols.map((c) => `${c} = ${formatCellValue(row[c])}`).join(", ");
  const title = [p.table, name].filter(Boolean).join(" · ") || "Row";
  const where = isNew ? "New row · not saved yet" : `Row ${p.index + 1} / ${p.loaded}${deleted ? " · will be deleted" : ""}`;
  // The sheet's keys are its fields': the grid under it must not undo or save on them.
  const keepKeys = (e: KeyboardEvent) => e.stopPropagation();

  return (
    <BottomSheet open onClose={p.onClose} className="popover-solid">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={keepKeys} className="flex max-h-[calc(var(--sheet-vh,100dvh)*0.9)] flex-col">
        <div className="flex shrink-0 items-center gap-2.5 pr-1.5 pb-1 pl-4">
          <h2 id={titleId} className="min-w-0 flex-1 text-[15px] font-semibold">
            <span className="block truncate">{title}</span>
            <small className="block truncate text-xs font-normal text-text-3">{where}</small>
          </h2>
          <button type="button" onClick={p.onClose} aria-label="Close" className="grid size-11 shrink-0 place-items-center rounded-lg text-text-2 active:bg-surface-hover">
            <X className="size-5" />
          </button>
        </div>
        <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] content-start gap-3 overflow-y-auto px-4 pt-1 pb-3">
          {p.columns.map((column) => (
            // A field per row: what was typed in one is not carried to the next.
            <RowField key={`${p.index}:${column}`} column={column} row={row} rowId={rowId} isNew={isNew} onDraft={onDraft} {...p} />
          ))}
        </div>
        <div className="flex shrink-0 gap-2 border-t border-border-soft px-3 pt-2.5">
          <button
            type="button" aria-label="Previous row" title="Previous row" disabled={p.index <= 0} onClick={() => p.onIndexChange(p.index - 1)}
            className="grid size-11 shrink-0 place-items-center rounded-lg border border-border text-text-2 active:bg-surface-hover disabled:opacity-40"
          >
            <ChevronLeft className="size-5" />
          </button>
          <button
            type="button" aria-label="Next row" title="Next row" disabled={p.index >= p.rows.length - 1} onClick={() => p.onIndexChange(p.index + 1)}
            className="grid size-11 shrink-0 place-items-center rounded-lg border border-border text-text-2 active:bg-surface-hover disabled:opacity-40"
          >
            <ChevronRight className="size-5" />
          </button>
          {p.onSave && (
            <button
              type="button" onClick={save}
              disabled={[...drafts.values()].includes(false) || (p.pending === 0 && drafts.size === 0)}
              aria-label={p.pending > 0 ? `Save ${p.pending} changed ${p.pending === 1 ? "row" : "rows"}` : "Save"}
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              <Save className="size-[18px]" />
              Save
              {p.pending > 0 && <span className="min-w-5 rounded-full bg-primary-foreground/20 px-1.5 text-xs tabular-nums">{p.pending}</span>}
            </button>
          )}
        </div>
      </div>
    </BottomSheet>
  );
}

function RowField({ column, row, rowId, isNew, schema, changeset, canEdit, onEdit, onDraft }: RowFormSheetProps & {
  column: string;
  row: Record<string, unknown>;
  rowId: string;
  isNew: boolean;
  onDraft: (column: string, valid: boolean | null) => void;
}) {
  const id = useId();
  const draftHere = useCallback((valid: boolean | null) => onDraft(column, valid), [onDraft, column]);
  const col = schema.get(column);
  const pending = changeset.cells.get(cellId(rowId, column));
  // A new row holds only what was put in it.
  const value = pending ? pending.newVal : isNew ? undefined : row[column];
  const binary = isBinaryValue(value);
  const locked = binary || !canEdit(row, column);
  const kind = col ? dbTypeToKind(col.type) : GridCellKind.Text;
  const asBoolean = kind === GridCellKind.Boolean && (value === undefined || value === null || typeof value === "boolean");
  const text = value === undefined || value === null ? "" : binary ? formatBinary(value) : formatCellValue(value);
  const put = (next: unknown) => {
    if (!Object.is(next, value ?? null)) onEdit([{ row, column, value: next }]);
  };

  const label = (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className={cn("truncate font-medium", col && !col.nullable && "underline decoration-dotted underline-offset-2")}>{column}</span>
      {col && <small className="shrink-0 truncate text-xs text-text-3">{col.type}</small>}
    </span>
  );

  return (
    <div className="grid gap-1 text-sm">
      <label htmlFor={id}>{label}</label>
      {asBoolean ? (
        <select
          id={id} disabled={locked}
          value={value === true ? "true" : value === false ? "false" : ""}
          onChange={(e) => put(e.target.value === "" ? null : e.target.value === "true")}
          className={cn(inputClass, pending && !isNew && "bg-warning/10")}
        >
          {/* A cell left as it is, in a new row: left out of the INSERT. */}
          {value === undefined && <option value="" disabled>{NO_FIELD_TEXT}</option>}
          {(value === null || col?.nullable) && value !== undefined && <option value="">{NULL_TEXT}</option>}
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <TextField
          id={id} text={text} locked={locked} number={kind === GridCellKind.Number}
          placeholder={value === undefined ? NO_FIELD_TEXT : value === null ? NULL_TEXT : undefined}
          edited={!!pending && !isNew} onCommit={put} onDraft={draftHere}
        />
      )}
      {pending && !isNew && <small className="truncate text-xs text-text-3">Was: {row[column] === null || row[column] === undefined ? NULL_TEXT : formatCellValue(row[column])}</small>}
    </div>
  );
}

/** A field that holds what is typed until it is left, then puts in a value: NULL when emptied. */
function TextField({ id, text, locked, number, placeholder, edited, onCommit, onDraft }: {
  id: string;
  text: string;
  locked: boolean;
  number: boolean;
  placeholder?: string;
  edited: boolean;
  onCommit: (value: unknown) => void;
  /** Whether it holds what was typed and not put in yet, and whether that reads as the column's type. */
  onDraft: (valid: boolean | null) => void;
}) {
  const [draft, setDraft] = useState(text);
  // What the cell holds changed under the field — undo, another field's edit of it — so it shows that.
  useEffect(() => setDraft(text), [text]);
  const parsed: { ok: true; value: unknown } | { ok: false } = draft === ""
    ? { ok: true, value: null }
    : number
      ? draft.trim() !== "" && Number.isFinite(Number(draft)) ? { ok: true, value: Number(draft) } : { ok: false }
      : { ok: true, value: draft };
  const commit = () => {
    if (draft === text || !parsed.ok) return;
    onCommit(parsed.value);
  };
  const valid = draft === text ? null : parsed.ok;
  useEffect(() => onDraft(valid), [valid, onDraft]);
  // Left with the sheet — another row, the sheet closed — rather than by a tap on another field.
  const leave = useRef(commit);
  leave.current = commit;
  useEffect(() => () => leave.current(), []);
  return (
    <>
      <input
        id={id} value={draft} readOnly={locked} placeholder={placeholder}
        inputMode={number ? "decimal" : undefined} autoComplete="off" autoCapitalize="off" spellCheck={false}
        aria-invalid={!parsed.ok || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); commit(); } }}
        className={cn(inputClass, number && "font-mono", edited && "bg-warning/10", locked && "text-text-2")}
      />
      {!parsed.ok && <small className="text-xs text-error">Not a number</small>}
    </>
  );
}
