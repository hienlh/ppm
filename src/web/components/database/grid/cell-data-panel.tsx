/**
 * DBGate's Cell data view: what the grid's selection holds, in the format picked in its Format box —
 * Autodetect's pick until another is chosen. Docked right of the grid, its edge dragging it between
 * 220 and 560px; in a narrow tab it floats over the grid; on a phone it is a bottom sheet. The text
 * formats and the Form format's fields change the cells, into the grid's change set.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { AlertCircle, ChevronDown, Info, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import type { GridColumnSchema } from "../glide-grid-types";
import { SearchBox, linkButtonClass } from "../explorer/tree-parts";
import { ColumnIcon } from "./columns-panel";
import { formatByteSize, isBinaryValue } from "./cell-display";
import type { CellChange } from "./grid-changeset";
import { fieldKind } from "./form-view";
import { formDisplayText, formEditText, parseFormText, type FormFieldKind } from "./form-view-model";
import { JsonTree } from "./json-tree";
import {
  CELL_DATA_FORMATS, autodetectFormat, bytesRead, cellDataFields, cellDataFormat, cellDataMessage, cellText, cellsText, choiceTitle,
  formJsonValue, htmlDocument, pictureUrl, readJson, rowsJson, rowsOfCells,
  type CellDataChoice, type CellDataFormat, type CellDataSelection,
} from "./cell-data-formats";

/** What the view shows and changes: the grid's selection, and the grid's ways of changing its rows. */
export interface CellDataSource {
  selection: CellDataSelection;
  /** The grid's columns, in its order: the Form format's fields. */
  columns: readonly GridColumnSchema[];
  /** The grid's row at a place, which a change names. */
  record: (row: number) => Record<string, unknown>;
  /** A row's identity, which holds while the rows around it are read again. */
  rowId: (row: number) => string;
  /** A row as it reads now, every column of it: Json - Row shows the hidden ones too. */
  rowValues: (row: number) => Record<string, unknown>;
  canEdit: (row: Record<string, unknown>, column: string) => boolean;
  /** One step of the change set. */
  onEdit: (changes: CellChange[]) => void;
  /** Ctrl+S in one of the view's editors, once what it holds is in the change set. */
  onSave: () => void;
}

/** The docked view's width, which its edge drags between these and this device keeps, as DBGate's does. */
export const CELL_DATA_WIDTH = { min: 220, max: 560, initial: 300 } as const;
const WIDTH_KEY = "ppm-db-cell-data-width";
const HIDE_NULL_KEY = "ppm-db-cell-data-hide-null";

export function clampCellDataWidth(width: number): number {
  if (!Number.isFinite(width)) return CELL_DATA_WIDTH.initial;
  return Math.round(Math.min(CELL_DATA_WIDTH.max, Math.max(CELL_DATA_WIDTH.min, width)));
}

export function readCellDataWidth(): number {
  try {
    const kept = Number(localStorage.getItem(WIDTH_KEY));
    return kept ? clampCellDataWidth(kept) : CELL_DATA_WIDTH.initial;
  } catch {
    return CELL_DATA_WIDTH.initial;
  }
}

export function keepCellDataWidth(width: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // Not kept: the view opens at the width it starts with.
  }
}

function readHideNull(): boolean {
  try {
    return localStorage.getItem(HIDE_NULL_KEY) === "1";
  } catch {
    return false;
  }
}

function keepHideNull(hide: boolean) {
  try {
    localStorage.setItem(HIDE_NULL_KEY, hide ? "1" : "0");
  } catch {
    // Not kept: the box starts unticked next time.
  }
}

/** ← and → on the edge: one step. */
const KEY_STEP = 16;

/**
 * The format picked, Autodetect's until another is — or until one is asked for from outside, as View
 * cell as JSON document asks for Json - expanded. An ask is taken once: `onAsked` lets it go, so the
 * view opened again later starts at Autodetect as it always does.
 */
function useFormatChoice(ask: CellDataChoice | null | undefined, onAsked: (() => void) | undefined) {
  const [choice, setChoice] = useState<CellDataChoice>(() => ask ?? "autodetect");
  useEffect(() => {
    if (!ask) return;
    setChoice(ask);
    onAsked?.();
  }, [ask]); // eslint-disable-line react-hooks/exhaustive-deps -- an ask, not a new callback
  return [choice, setChoice] as const;
}

/** The view beside the grid: docked with a draggable edge, or — in a narrow tab — floating over it. */
export function CellDataPanel({ source, width, onWidthChange, floating, onClose, ask, onAsked }: {
  source: CellDataSource;
  width: number;
  /** Called once a drag ends, so one width is kept. */
  onWidthChange: (width: number) => void;
  floating: boolean;
  /** `hadFocus`: the view held the focus, which goes back to the grid. */
  onClose: (hadFocus: boolean) => void;
  /** A format to show, asked for from outside (useFormatChoice). */
  ask?: CellDataChoice | null;
  onAsked?: () => void;
}) {
  const titleId = useId();
  const formatId = useId();
  const asideRef = useRef<HTMLElement>(null);
  const [choice, setChoice] = useFormatChoice(ask, onAsked);
  const detected = autodetectFormat(source.selection.cells);
  const [dragging, setDragging] = useState<number | null>(null);
  const start = useRef<{ x: number; width: number } | null>(null);
  const shown = dragging ?? width;
  const close = () => onClose(!!asideRef.current?.contains(asideRef.current.ownerDocument.activeElement));

  // The edge is on the left: dragged left, the view grows.
  const widthAt = (clientX: number) => clampCellDataWidth(start.current!.width - (clientX - start.current!.x));
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width };
    setDragging(width);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current) setDragging(widthAt(e.clientX));
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const next = widthAt(e.clientX);
    start.current = null;
    setDragging(null);
    if (next !== width) onWidthChange(next);
  };
  const onSplitKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? KEY_STEP : e.key === "ArrowRight" ? -KEY_STEP : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next = e.key === "Home" ? CELL_DATA_WIDTH.min : e.key === "End" ? CELL_DATA_WIDTH.max : clampCellDataWidth(width + step);
    if (next !== width) onWidthChange(next);
  };

  return (
    <>
      {!floating && (
        <div
          role="separator" aria-orientation="vertical" aria-label="Resize the cell data view" tabIndex={0}
          aria-valuemin={CELL_DATA_WIDTH.min} aria-valuemax={CELL_DATA_WIDTH.max} aria-valuenow={shown}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
          onKeyDown={onSplitKey}
          className={cn(
            "relative z-10 -mr-[3px] -ml-1 w-[7px] shrink-0 cursor-col-resize touch-none outline-none",
            "before:absolute before:inset-y-0 before:left-[3px] before:w-px before:bg-transparent",
            "can-hover:hover:before:bg-primary focus-visible:before:bg-primary",
            dragging !== null && "before:bg-primary",
          )}
        />
      )}
      <aside
        ref={asideRef} aria-labelledby={titleId} data-cell-data-view=""
        onKeyDown={(e) => {
          if (!floating || e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          e.stopPropagation();
          close();
        }}
        style={{ width: floating ? `min(${shown}px, 86%)` : shown }}
        className={cn(
          "flex shrink-0 flex-col overflow-hidden border-l border-border bg-panel",
          floating && "absolute inset-y-0 right-0 z-30 shadow-[-14px_0_34px_-14px_rgb(0_0_0/0.45)]",
        )}
      >
        <div className="flex h-[30px] shrink-0 items-center gap-1.5 pr-1 pl-2.5 text-xs">
          <h3 id={titleId} className="min-w-0 flex-1 truncate font-semibold">Cell data view</h3>
          <button
            type="button" onClick={close} aria-label="Close the cell data view" title="Close"
            className="grid size-6 shrink-0 place-items-center rounded text-text-3 can-hover:hover:bg-surface-hover can-hover:hover:text-text"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <FormatPicker id={formatId} choice={choice} detected={detected} onChange={setChoice} />
        <div className="flex min-h-0 flex-1 flex-col overflow-auto border-t border-border-soft bg-background">
          <CellDataBody source={source} format={choice === "autodetect" ? detected : choice} />
        </div>
      </aside>
    </>
  );
}

/** A phone's view: the same formats in a bottom sheet, the format it shows under its title. */
export function CellDataSheet({ source, onClose, ask, onAsked }: {
  source: CellDataSource;
  onClose: () => void;
  ask?: CellDataChoice | null;
  onAsked?: () => void;
}) {
  const titleId = useId();
  const formatId = useId();
  const [choice, setChoice] = useFormatChoice(ask, onAsked);
  const detected = autodetectFormat(source.selection.cells);
  return (
    <BottomSheet open onClose={onClose} className="popover-solid">
      {/* The sheet's keys are its editors': the grid under it must not undo or save on them. */}
      <div
        role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={(e) => e.stopPropagation()}
        className="flex h-[calc(var(--sheet-vh,100dvh)*0.8)] flex-col"
      >
        <div className="flex shrink-0 items-center gap-2.5 pr-1.5 pb-1 pl-4">
          <h2 id={titleId} className="min-w-0 flex-1 text-[15px] font-semibold">
            <span className="block truncate">Cell data view</span>
            <small className="block truncate text-xs font-normal text-text-3">Format: {choiceTitle(choice, detected)}</small>
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-11 shrink-0 place-items-center rounded-lg text-text-2 active:bg-surface-hover">
            <X className="size-5" />
          </button>
        </div>
        <FormatPicker id={formatId} choice={choice} detected={detected} onChange={setChoice} sheet />
        <div className="flex min-h-0 flex-1 flex-col overflow-auto border-y border-border-soft bg-background">
          <CellDataBody source={source} format={choice === "autodetect" ? detected : choice} sheet />
        </div>
        <div className="flex shrink-0 px-3 pt-2.5">
          <button type="button" onClick={onClose} className="h-11 flex-1 rounded-lg bg-primary text-sm font-medium text-primary-foreground">
            Done
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

function FormatPicker({ id, choice, detected, onChange, sheet = false }: {
  id: string;
  choice: CellDataChoice;
  detected: CellDataFormat;
  onChange: (choice: CellDataChoice) => void;
  sheet?: boolean;
}) {
  return (
    <div className={cn("flex shrink-0 items-center gap-2 px-2.5 pb-2 text-xs text-text-2", sheet && "px-4 pt-1 text-sm")}>
      <label htmlFor={id} className="shrink-0">Format:</label>
      <span className="relative min-w-0 flex-1">
        <select
          id={id} value={choice} onChange={(e) => onChange(e.target.value as CellDataChoice)}
          className="h-[26px] w-full min-w-0 appearance-none rounded-[5px] border border-border bg-input pr-[26px] pl-2 text-xs text-foreground outline-none focus:border-primary max-md:h-11 max-md:text-sm"
        >
          <option value="autodetect">{choiceTitle("autodetect", detected)}</option>
          {CELL_DATA_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-1.5 size-3.5 -translate-y-1/2 text-text-subtle" />
      </span>
    </div>
  );
}

function Message({ children, error = false }: { children: ReactNode; error?: boolean }) {
  const Icon = error ? AlertCircle : Info;
  return (
    <p role="status" className="flex items-start gap-2 px-3 py-3.5 text-[12.5px] text-text-3">
      <Icon className={cn("mt-px size-4 shrink-0", error ? "text-error" : "text-primary")} aria-hidden />
      {children}
    </p>
  );
}

/** What the format makes of the selection, or what DBGate says in its place. */
function CellDataBody({ source, format, sheet = false }: { source: CellDataSource; format: CellDataFormat; sheet?: boolean }) {
  const { cells } = source.selection;
  const message = cellDataMessage(cellDataFormat(format), source.selection);
  if (message) return <Message>{message}</Message>;
  // A single-cell format has exactly one past the message.
  const one = cells[0]!;
  switch (format) {
    case "textWrap":
    case "text":
      return <TextFormat source={source} wrap={format === "textWrap"} />;
    case "json":
    case "jsonExpanded": {
      const read = readJson(one.value);
      if (!read.ok) return <Message error>Error parsing JSON</Message>;
      return <JsonTree key={`${format}:${source.rowId(one.row)}:${one.column}`} value={read.value} expandAll={format === "jsonExpanded"} className="px-1.5 py-2.5" />;
    }
    case "jsonRow": {
      const rows = rowsOfCells(cells);
      return <JsonTree key={rows.map(source.rowId).join("\u0000")} value={rowsJson(rows.map(source.rowValues))} className="px-1.5 py-2.5" />;
    }
    case "form":
      return <FormFormat source={source} sheet={sheet} />;
    case "picture":
      return <PictureFormat key={pictureUrl(one.value) ?? ""} value={one.value} />;
    case "html":
      return <HtmlFormat html={cellsText(cells)} />;
    case "xml":
      return <pre className="m-0 min-h-0 flex-1 overflow-auto px-3 py-2.5 font-mono text-xs leading-[1.55] whitespace-pre">{cellsText(cells)}</pre>;
  }
}

const textAreaClass = "min-h-[120px] w-full flex-1 resize-none border-0 bg-transparent px-3 py-2.5 font-mono text-xs leading-[1.55] text-text outline-none";

/**
 * Text (wrap) and Text (no wrap): every selected value on a line of its own, as DBGate shows them.
 * One cell that can change is typed into; several, or one that cannot, are read only.
 */
function TextFormat({ source, wrap }: { source: CellDataSource; wrap: boolean }) {
  const { cells } = source.selection;
  const one = cells.length === 1 ? cells[0]! : null;
  const column = one ? source.columns.find((c) => c.name === one.column) : undefined;
  const record = one ? source.record(one.row) : undefined;
  if (one && column && record && !isBinaryValue(one.value) && source.canEdit(record, one.column)) {
    return (
      <TextEditor
        // Another cell is another editor: what was typed in this one goes to this one.
        key={`${source.rowId(one.row)}\u0000${one.column}`}
        column={one.column} kind={fieldKind(column)} text={cellText(one.value)} wrap={wrap}
        placeholder={one.value === null ? "(NULL)" : one.value === undefined ? "(No Field)" : undefined}
        onCommit={(value) => source.onEdit([{ row: record, column: one.column, value }])} onSave={source.onSave}
      />
    );
  }
  return (
    <textarea
      readOnly value={cellsText(cells)} wrap={wrap ? "soft" : "off"} aria-label="Cell value" spellCheck={false}
      className={cn(textAreaClass, "text-text-2", !wrap && "overflow-x-auto whitespace-pre")}
    />
  );
}

/**
 * One cell's value, typed in place. What was typed goes in when the box is left — not on every key,
 * as DBGate's does, which would make each letter a step to undo — and also when it is taken away
 * with what was typed still in it: another cell selected, the view closed.
 */
function TextEditor({ column, kind, text, wrap, placeholder, onCommit, onSave }: {
  column: string;
  kind: FormFieldKind;
  /** What the cell holds now. */
  text: string;
  wrap: boolean;
  placeholder?: string;
  onCommit: (value: unknown) => void;
  onSave: () => void;
}) {
  // Null while nothing is typed: the box then shows what the cell holds, which an undo can change.
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const keepDraft = (next: string | null) => {
    draftRef.current = next;
    setDraft(next);
  };
  /** Puts what was typed in; false when it does not read as the column's type, and was dropped. */
  const commit = (): boolean => {
    const typed = draftRef.current;
    if (typed === null) return true;
    keepDraft(null);
    if (typed === text) return true;
    const parsed = parseFormText(typed, kind);
    if (!parsed.ok) {
      toast.error(`${column}: ${parsed.error}`, { description: "What was typed was not kept." });
      return false;
    }
    onCommit(parsed.value);
    return true;
  };
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => () => { latest.current(); }, []);

  const parsed = draft === null ? null : parseFormText(draft, kind);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape" && draftRef.current !== null) {
      e.preventDefault();
      e.stopPropagation();
      keepDraft(null);
      return;
    }
    // The grid's Save would write the change set without what is typed here.
    if (mod && (e.key === "Enter" || e.key.toLowerCase() === "s")) {
      e.preventDefault();
      e.stopPropagation();
      if (commit()) onSave();
    }
  };
  return (
    <>
      <textarea
        value={draft ?? text} onChange={(e) => keepDraft(e.target.value)} onBlur={() => { commit(); }} onKeyDown={onKeyDown}
        wrap={wrap ? "soft" : "off"} placeholder={placeholder} spellCheck={false} autoCapitalize="off" autoComplete="off"
        // The table's keys leave it alone, as they leave the grid's own cell editor.
        data-cell-editor="" aria-label={`Edit ${column}`} aria-invalid={parsed?.ok === false || undefined}
        className={cn(textAreaClass, "placeholder:text-text-3 placeholder:italic", !wrap && "overflow-x-auto whitespace-pre")}
      />
      {parsed?.ok === false && <p className="shrink-0 border-t border-border-soft px-3 py-1 text-xs text-error">{parsed.error}</p>}
    </>
  );
}

/**
 * The Form format: a field per column of the grid, for the row the selection lies on — or for all of
 * them, a field whose rows disagree reading (Multiple values). A value is changed in place, in every
 * selected row; Filter columns narrows the fields and Hide NULL values drops the empty ones.
 */
function FormFormat({ source, sheet }: { source: CellDataSource; sheet: boolean }) {
  const hideNullId = useId();
  const [filter, setFilter] = useState("");
  const [hideNull, setHideNull] = useState(readHideNull);
  const rows = rowsOfCells(source.selection.cells);
  const rowsKey = rows.map(source.rowId).join("\u0000");
  const records = rows.map(source.record);
  const fields = cellDataFields(source.columns.map((c) => c.name), rows.map(source.rowValues), filter, hideNull);
  const schemaOf = new Map(source.columns.map((c) => [c.name, c]));
  // The field being typed in, for the rows it was opened on: other rows selected, it is put away.
  const [editing, setEditing] = useState<{ column: string; rows: string } | null>(null);
  useEffect(() => setEditing(null), [rowsKey]);
  const valueRefs = useRef(new Map<string, HTMLElement>());
  const [refocus, setRefocus] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (refocus === null) return;
    setRefocus(null);
    valueRefs.current.get(refocus)?.focus({ preventScroll: true });
  }, [refocus]);

  const editable = (column: string, value: unknown) => !isBinaryValue(value) && records.some((r) => source.canEdit(r, column));
  const startEditing = (column: string) => setEditing({ column, rows: rowsKey });
  /** DBGate's Tab, ↑ and ↓ in an editor: the next field — the one before, going back — or none past the ends. */
  const nextField = (column: string, reverse: boolean) => {
    const at = fields.findIndex((f) => f.column === column);
    return fields[reverse ? at - 1 : at + 1] ?? null;
  };

  return (
    <div className="grid content-start bg-panel">
      <div className="grid gap-1.5 border-b border-border-soft px-2.5 py-2">
        <SearchBox value={filter} onChange={setFilter} placeholder="Filter columns" />
        <label htmlFor={hideNullId} className="flex cursor-pointer items-center gap-1.5 text-xs text-text-2 select-none max-md:min-h-11 max-md:text-sm">
          <input
            id={hideNullId} type="checkbox" checked={hideNull} className="size-3.5 cursor-pointer accent-primary max-md:size-5"
            onChange={(e) => { setHideNull(e.target.checked); keepHideNull(e.target.checked); }}
          />
          Hide NULL values
        </label>
      </div>
      {fields.map((f) => {
        const col = schemaOf.get(f.column);
        const canChange = editable(f.column, f.value);
        const json = f.multiple ? null : formJsonValue(f.value);
        const open = editing?.column === f.column && editing.rows === rowsKey;
        // A click on a value edits it, bar a JSON one, whose tree is clicked to fold: Edit opens that.
        const clickable = canChange && !json && !open;
        return (
          <div key={f.column} className="min-w-0 border-b border-border-soft px-2.5 pt-1.5 pb-2">
            <div className="flex min-w-0 items-center gap-[5px] text-xs text-text-2">
              {col ? <ColumnIcon col={col} className="size-3.5" /> : <span className="size-3.5 shrink-0" aria-hidden />}
              <span className={cn("min-w-0 shrink truncate", col && !col.nullable && "font-semibold text-text")}>{f.column}</span>
              {col && <span className="min-w-0 shrink truncate font-mono text-[10.5px] text-text-3">{col.type}</span>}
              {canChange && !open && (
                <button
                  type="button" onClick={() => startEditing(f.column)} aria-label={`Edit ${f.column}`}
                  className={cn(linkButtonClass, "ml-auto shrink-0 text-[11.5px]", sheet && "px-1 text-[13px]")}
                >
                  Edit
                </button>
              )}
            </div>
            <div
              ref={(el) => { if (el) valueRefs.current.set(f.column, el); else valueRefs.current.delete(f.column); }}
              tabIndex={clickable ? 0 : -1} role={clickable ? "button" : undefined}
              aria-label={clickable ? `${f.column}: edit the value` : undefined}
              onClick={clickable ? () => startEditing(f.column) : undefined}
              onKeyDown={clickable ? (e) => {
                if (e.key !== "Enter" && e.key !== "F2") return;
                e.preventDefault();
                startEditing(f.column);
              } : undefined}
              className={cn("min-w-0 pt-0.5 pl-[19px] text-[12.5px] outline-none [overflow-wrap:anywhere] focus-visible:bg-accent-wash", clickable && "cursor-text", sheet && clickable && "min-h-11")}
            >
              {open ? (
                <FieldEditor
                  column={f.column} kind={col ? fieldKind(col) : "text"} initial={f.multiple ? "" : formEditText(f.value)} selectAll={!f.multiple}
                  onCommit={(value) => source.onEdit(records.map((row) => ({ row, column: f.column, value })))}
                  onSetNull={() => source.onEdit(records.map((row) => ({ row, column: f.column, value: null })))}
                  next={(reverse) => nextField(f.column, reverse)?.column ?? null}
                  onMove={(column) => {
                    const target = fields.find((x) => x.column === column);
                    if (target && editable(target.column, target.value)) startEditing(column);
                    else { setEditing(null); setRefocus(column); }
                  }}
                  onClose={(again) => { setEditing(null); if (again) setRefocus(f.column); }}
                  onSave={source.onSave}
                />
              ) : f.multiple ? (
                <span className="text-text-3 italic">(Multiple values)</span>
              ) : json ? (
                <JsonTree value={json} />
              ) : (
                <FieldValue value={f.value} />
              )}
            </div>
          </div>
        );
      })}
      {fields.length === 0 && <Message>{filter.trim() ? `No column matches “${filter.trim()}”` : "No columns to show"}</Message>}
    </div>
  );
}

function FieldValue({ value }: { value: unknown }) {
  const text = formDisplayText(value);
  if (value === null || value === undefined) return <span className="text-text-3 italic">{text}</span>;
  if (isBinaryValue(value)) return <span className="text-text-3">{text}</span>;
  return <span className="whitespace-pre-wrap">{text}</span>;
}

/**
 * DBGate's editor in a Form field: Enter puts the value in, Escape leaves it as it was, Ctrl+0 sets
 * NULL, and Tab, ↑ and ↓ put it in and go on to edit the next field — the one before, with Shift+Tab
 * or ↑. Leaving it any other way puts it in too, as long as it reads as the column's type.
 */
function FieldEditor({ column, kind, initial, selectAll, onCommit, onSetNull, next, onMove, onClose, onSave }: {
  column: string;
  kind: FormFieldKind;
  initial: string;
  selectAll: boolean;
  onCommit: (value: unknown) => void;
  onSetNull: () => void;
  /** The field Tab, ↑ or ↓ goes to; null past the ends, where the key does nothing. */
  next: (reverse: boolean) => string | null;
  onMove: (column: string) => void;
  /** `refocus`: left by a key, so its field takes the focus. */
  onClose: (refocus: boolean) => void;
  onSave: () => void;
}) {
  const [text, setText] = useState(initial);
  const textRef = useRef(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const closed = useRef(false);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (selectAll) el.select();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /** Puts what was typed in; false when it does not read as the column's type. */
  const commit = (): boolean => {
    if (textRef.current === initial) return true;
    const parsed = parseFormText(textRef.current, kind);
    if (!parsed.ok) return false;
    onCommit(parsed.value);
    return true;
  };
  /** Left without a key — clicked away from, or taken away — what was typed goes in, or is said to be dropped. */
  const commitOrTell = () => {
    if (commit()) return;
    const read = parseFormText(textRef.current, kind);
    if (!read.ok) toast.error(`${column}: ${read.error}`, { description: "What was typed was not kept." });
  };
  // Taken away with something typed in it — other rows selected, the view closed — it still goes in.
  const latest = useRef(commitOrTell);
  latest.current = commitOrTell;
  useEffect(() => () => {
    if (closed.current) return;
    closed.current = true;
    latest.current();
  }, []);
  const close = (refocus: boolean) => {
    closed.current = true;
    onClose(refocus);
  };
  const parsed = parseFormText(text, kind);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === "Escape") { stop(); close(true); return; }
    if (e.key === "Enter" && !mod) { stop(); if (commit()) close(true); return; }
    if (mod && e.key === "0") { stop(); closed.current = true; onSetNull(); onClose(true); return; }
    if (e.key === "Tab" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      stop();
      const to = next(e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey));
      if (to === null || !commit()) return;
      closed.current = true;
      onMove(to);
      return;
    }
    // The grid's Save would write the change set without what is typed here.
    if (mod && (e.key === "Enter" || e.key.toLowerCase() === "s")) {
      stop();
      if (!commit()) return;
      close(true);
      onSave();
    }
  };
  return (
    <input
      ref={inputRef} value={text} onKeyDown={onKeyDown}
      onChange={(e) => { textRef.current = e.target.value; setText(e.target.value); }}
      onBlur={() => {
        if (closed.current) return;
        commitOrTell();
        close(false);
      }}
      data-cell-editor="" aria-label={`Edit ${column}`} aria-invalid={!parsed.ok || undefined} title={parsed.ok ? undefined : parsed.error}
      inputMode={kind === "number" ? "decimal" : undefined} autoComplete="off" autoCapitalize="off" spellCheck={false}
      className={cn(
        "block h-6 w-full min-w-0 rounded-[3px] border border-primary bg-background px-1 text-[12.5px] text-text outline-none max-md:h-11 max-md:text-sm",
        kind === "number" && "font-mono",
        !parsed.ok && "border-error text-error",
      )}
    />
  );
}

/** Picture: the bytes drawn as an image — "Error showing picture" when they are none a browser can draw. */
function PictureFormat({ value }: { value: unknown }) {
  const url = pictureUrl(value);
  const [failed, setFailed] = useState(false);
  if (!url || failed || !isBinaryValue(value)) return <Message error>Error showing picture</Message>;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2.5">
      {value.truncated && (
        <p className="mb-2 text-xs text-text-3">
          Only the first {formatByteSize(bytesRead(value))} of {formatByteSize(value.size)} came with the row: the picture may be cut short.
        </p>
      )}
      <img src={url} alt="The cell's picture" onError={() => setFailed(true)} className="block max-w-full" />
    </div>
  );
}

/** HTML: the value drawn by the browser in a frame that runs no script and loads nothing from the network. */
function HtmlFormat({ html }: { html: string }) {
  const probeRef = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState<{ text: string; background: string } | null>(null);
  // The theme's colours as the browser resolved them: a token can be `light-dark()`, which the frame
  // would resolve against its own colour scheme.
  useLayoutEffect(() => {
    const el = probeRef.current;
    if (!el) return;
    const style = getComputedStyle(el);
    setColors((c) => (c && c.text === style.color && c.background === style.backgroundColor ? c : { text: style.color, background: style.backgroundColor }));
  });
  return (
    <div ref={probeRef} className="flex min-h-0 flex-1 flex-col bg-background text-text">
      {colors && (
        <iframe title="HTML value" sandbox="" referrerPolicy="no-referrer" srcDoc={htmlDocument(html, colors)} className="block min-h-0 w-full flex-1 border-0" />
      )}
    </div>
  );
}
