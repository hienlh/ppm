/**
 * DBGate's toolstrip on a table's data, in its order: Structure ↗ · SQL ↗ · Refresh ▾ · Save ·
 * Revert all · New row · Delete row(s) · Switch to form · Export ▾ · Fetch all · View columns ·
 * Cell Data, then PPM's read-only switch at the far end. The form view's (F4) has First · Previous ·
 * Next · Last after Refresh and Switch to table in place of Switch to form, and no New row,
 * Delete row(s), Fetch all or Cell Data. A button that cannot act is hidden; Save only greys out, and says why. Labels give way
 * as the tab narrows — the ↗ and the labels of Export, Fetch all and View columns first (≤ 1200px),
 * then every one (≤ 900px). A phone has no strip: its buttons are one ⋯ menu in the tab's header,
 * and New row, the panel's sheet and Save sit in the thumb bar.
 */
import { useState, type ElementType, type ReactNode } from "react";
import {
  ArrowDownToLine, ArrowNext, ArrowPrevious, ArrowRightFromLine, ChevronLeft, ChevronRight, Code, Columns3, Filter, FolderTree, Form, Hash,
  Minus, MoreVertical, PanelRight, Plus, Redo2, RefreshCw, Save, ShieldCheck, ShieldOff, TableSimple, Timer, Undo2,
} from "@/lib/icons";
import { cn } from "@/lib/utils";
import { formatCombo } from "@/stores/keybindings-store";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { ExportButton, type GridExport } from "../export-button";
import { GRID_EXPORT_FORMATS } from "../../../../shared/db-grid-export";
import type { GridEditState } from "../glide-grid-types";
import { DbToolButton, DbToolbar, toolButtonClass } from "../db-tab-parts";
import { RefreshButton, refreshMenuItems, type AutoRefresh } from "./refresh-menu";
import type { FormNavigation } from "./form-view-model";

/** What the table's buttons act on: one object, drawn as the desktop strip or as a phone's menu. */
export interface TableActions {
  table: string;
  /** Structure and SQL open tabs of their own, which a view with no place to open them cannot. */
  canOpenTabs: boolean;
  onOpenStructure: () => void;
  onOpenSql: () => void;
  onRefresh: () => void;
  onRefreshWithStructure: () => void;
  auto: AutoRefresh;
  /** Rows are being read. */
  busy: boolean;
  /** Nothing is shown yet, so there is nothing to refresh. */
  idle: boolean;
  /** The grid's edits and selection; null until it has rows. */
  edit: GridEditState | null;
  readonly: boolean;
  onSave: () => void;
  onRevert: () => void;
  onNewRow: () => void;
  onDeleteRows: () => void;
  /** A step of the change set back, or forward again: a phone's menu has them, a keyboard Ctrl+Z / Ctrl+Y. */
  onUndo: () => void;
  onRedo: () => void;
  /** Export ▾: every row the filters select, written by the server; absent until the table is shown. */
  export?: GridExport;
  hasMore: boolean;
  onFetchAll: () => void;
  /** The left panel, which View columns shows and hides; absent where there is none. */
  panel?: { open: boolean; onToggle: () => void };
  /**
   * DBGate's Form view (F4): on, Switch to table and the form's First … Last; off, Switch to form —
   * which on a phone opens the current row in its sheet. Absent where rows cannot be shown as one.
   */
  form?: { on: boolean; onToggle: () => void; onNavigate: (to: FormNavigation) => void };
  /** DBGate's Cell Data: the selection's values beside the grid; a phone's Show cell data opens them in a sheet. */
  cellData?: { open: boolean; onToggle: () => void };
  /** PPM's read-only switch: only a saved connection has one. */
  onToggleReadonly?: () => void;
  /** The count gave up: count every row. A desktop clicks "Rows: …" in the grid's corner instead. */
  onCountExactly?: () => void;
}

/** Save's look: the rows it would write, and whether it can — a read-only connection cannot. */
export function saveButtonState(edit: GridEditState | null, readonly: boolean): { count: number; disabled: boolean; title: string } {
  const count = edit?.pending ?? 0;
  return {
    count,
    disabled: count === 0 || readonly,
    title: readonly ? "The connection is read-only" : `Table data: Save (${formatCombo("Mod+S")})`,
  };
}

/** Which of the buttons that come and go are there. */
export function tableButtons(a: Pick<TableActions, "edit" | "readonly" | "hasMore" | "form">) {
  // The form view shows one row: rows are added and deleted in the grid, and read as it goes.
  const inForm = !!a.form?.on;
  const rowsChange = !!a.edit?.canChangeRows && !a.readonly && !inForm;
  return {
    revert: !!a.edit && (a.edit.pending > 0 || a.edit.newRows > 0),
    newRow: rowsChange,
    deleteRows: rowsChange && a.edit!.selectedRows > 0,
    fetchAll: a.hasMore && !inForm,
  };
}

/** The form view's First · Previous · Next · Last, as DBGate's toolbar has them. */
export const FORM_NAVIGATION = [
  { to: "first", label: "First", icon: ArrowPrevious, combo: "Mod+Home" },
  { to: "previous", label: "Previous", icon: ChevronLeft, combo: "Mod+\u2191" },
  { to: "next", label: "Next", icon: ChevronRight, combo: "Mod+\u2193" },
  { to: "last", label: "Last", icon: ArrowNext, combo: "Mod+End" },
] as const satisfies readonly { to: FormNavigation; label: string; icon: ElementType; combo: string }[];

/** Whether a step of the form's can be taken: not back from the first row, nor on from the last. */
export function formStepDisabled(edit: GridEditState | null, to: FormNavigation): boolean {
  const at = edit?.form;
  if (!at) return true;
  return to === "first" || to === "previous" ? at.atFirst : at.atLast;
}

/** Save's number, as DBGate draws it: nothing at 0, and no wider than "9+". */
export const countBadge = (n: number) => (n > 9 ? "9+" : String(n));

const CountBadge = ({ n, className }: { n: number; className?: string }) => (
  <span aria-hidden className={cn("min-w-4 rounded-full bg-warning/20 px-1 text-center font-mono text-[10.5px] leading-4 font-semibold text-warning", className)}>
    {countBadge(n)}
  </span>
);

const LABEL_LATE = "@max-[900px]:hidden";
const LABEL_EARLY = "@max-[1200px]:hidden";

export function TableToolbar({ actions: a }: { actions: TableActions }) {
  const save = saveButtonState(a.edit, a.readonly);
  const shown = tableButtons(a);
  return (
    <DbToolbar label={a.table}>
      <DbToolButton
        icon={FolderTree} label="Structure" title={`Open the structure of ${a.table} in its own tab`}
        onClick={a.onOpenStructure} opensTab disabled={!a.canOpenTabs} labelClassName={LABEL_LATE} arrowClassName={LABEL_EARLY}
      />
      <DbToolButton
        icon={Code} label="SQL" title={`Open the SQL of ${a.table} in its own tab`}
        onClick={a.onOpenSql} opensTab disabled={!a.canOpenTabs} labelClassName={LABEL_LATE} arrowClassName={LABEL_EARLY}
      />
      <RefreshButton onRefresh={a.onRefresh} onRefreshWithStructure={a.onRefreshWithStructure} auto={a.auto} busy={a.busy} disabled={a.idle} form={a.form?.on} />
      {a.form?.on && FORM_NAVIGATION.map(({ to, label, icon, combo }) => (
        <DbToolButton
          key={to} icon={icon} label={label} title={`Data form: ${label} (${formatCombo(combo)})`}
          onClick={() => a.form!.onNavigate(to)} disabled={formStepDisabled(a.edit, to)} labelClassName={LABEL_LATE}
        />
      ))}
      <button
        type="button" onClick={a.onSave} disabled={save.disabled} title={save.title}
        aria-label={save.count ? `Save ${save.count} changed ${save.count === 1 ? "row" : "rows"}` : "Save"}
        // A disabled Save still shows its tooltip: on a read-only connection that is the reason.
        className={cn(toolButtonClass, "disabled:pointer-events-auto disabled:cursor-default")}
      >
        <Save className="size-4 shrink-0" />
        <span className={LABEL_LATE}>Save</span>
        {save.count > 0 && <CountBadge n={save.count} />}
      </button>
      {shown.revert && <DbToolButton icon={Undo2} label="Revert all" title="Data grid: Revert all" onClick={a.onRevert} labelClassName={LABEL_LATE} />}
      {shown.newRow && <DbToolButton icon={Plus} label="New row" title="Data grid: New row (Insert)" onClick={a.onNewRow} labelClassName={LABEL_LATE} />}
      {shown.deleteRows && (
        <DbToolButton
          icon={Minus} label="Delete row(s)" title={`Data grid: Delete row(s) (${formatCombo("Mod+Delete")})`}
          onClick={a.onDeleteRows} labelClassName={LABEL_LATE}
        />
      )}
      {a.form && (a.form.on
        ? <DbToolButton icon={TableSimple} label="Switch to table" title="Data grid: Switch to table (F4)" onClick={a.form.onToggle} labelClassName={LABEL_LATE} />
        : <DbToolButton icon={Form} label="Switch to form" title="Data grid: Switch to form (F4)" onClick={a.form.onToggle} disabled={a.idle} labelClassName={LABEL_LATE} />)}
      {a.export && <ExportButton exporter={a.export} labelClassName={LABEL_EARLY} />}
      {shown.fetchAll && <DbToolButton icon={ArrowDownToLine} label="Fetch all" title="Data grid: Fetch all" onClick={a.onFetchAll} labelClassName={LABEL_EARLY} />}
      {a.panel && (
        <button
          type="button" onClick={a.panel.onToggle} aria-pressed={a.panel.open}
          title={`View columns (${formatCombo("Mod+L")})`} aria-label="View columns"
          className={cn(toolButtonClass, a.panel.open && "bg-accent-wash text-primary can-hover:hover:bg-accent-wash can-hover:hover:text-primary")}
        >
          <Columns3 className="size-4 shrink-0" />
          <span className={LABEL_EARLY}>View columns</span>
        </button>
      )}
      {a.cellData && !a.form?.on && (
        <button
          type="button" onClick={a.cellData.onToggle} aria-pressed={a.cellData.open}
          title="Data grid: Toggle cell data view" aria-label="Cell Data"
          className={cn(toolButtonClass, a.cellData.open && "bg-accent-wash text-primary can-hover:hover:bg-accent-wash can-hover:hover:text-primary")}
        >
          <PanelRight className="size-4 shrink-0" />
          <span className={LABEL_EARLY}>Cell Data</span>
        </button>
      )}
      {a.onToggleReadonly && <ReadonlySwitch readonly={a.readonly} onToggle={a.onToggleReadonly} />}
    </DbToolbar>
  );
}

function ReadonlySwitch({ readonly, onToggle }: { readonly: boolean; onToggle: () => void }) {
  return (
    <button
      type="button" onClick={onToggle}
      aria-pressed={!readonly}
      aria-label={readonly ? "Read-only: allow writes" : "Writes allowed: make read-only"}
      title={readonly ? "Read-only — click to allow writes" : "WRITE mode — click to make read-only"}
      className={cn(toolButtonClass, "ml-auto", !readonly && "bg-destructive/15 text-destructive can-hover:hover:bg-destructive/20 can-hover:hover:text-destructive")}
    >
      {readonly ? <ShieldCheck className="size-4 shrink-0" /> : <ShieldOff className="size-4 shrink-0" />}
      <span className={cn(LABEL_LATE, !readonly && "font-medium")}>{readonly ? "Read-only" : "WRITE"}</span>
    </button>
  );
}

interface SheetItem {
  label: string;
  icon: ElementType;
  onSelect: () => void;
  disabled?: boolean;
  /** Opens a list of its own, which Back leaves. */
  sub?: boolean;
  hint?: string;
}

/** A phone's ⋯ in the tab's header: the toolstrip as one menu, Export a list of its own with Back. */
export function TableActionsMenu({ actions: a }: { actions: TableActions }) {
  const [open, setOpen] = useState(false);
  const [exportList, setExportList] = useState(false);
  const close = () => {
    setOpen(false);
    setExportList(false);
  };
  const shown = tableButtons(a);
  const [withStructure, autoItem] = refreshMenuItems(a.onRefreshWithStructure, a.auto);

  const items: (SheetItem | "separator")[] = [
    { label: "Structure", icon: FolderTree, onSelect: a.onOpenStructure, disabled: !a.canOpenTabs },
    { label: "SQL", icon: Code, onSelect: a.onOpenSql, disabled: !a.canOpenTabs },
    "separator",
    { label: "Refresh", icon: RefreshCw, onSelect: a.onRefresh, disabled: a.idle },
    { label: withStructure!.label, icon: RefreshCw, onSelect: withStructure!.onSelect, disabled: a.idle },
    { label: autoItem!.label, icon: Timer, onSelect: autoItem!.onSelect, disabled: a.idle, hint: a.auto.running ? `every ${a.auto.every}s` : undefined },
    // The current row, in the row sheet: a phone's form view.
    ...(a.form ? [{ label: "Switch to form", icon: Form, onSelect: a.form.onToggle, disabled: !a.edit }] : []),
    ...(a.cellData ? [{ label: "Show cell data", icon: PanelRight, onSelect: a.cellData.onToggle, disabled: !a.edit }] : []),
    ...(shown.fetchAll ? [{ label: "Fetch all rows", icon: ArrowDownToLine, onSelect: a.onFetchAll }] : []),
    ...(a.onCountExactly ? [{ label: "Count every row", icon: Hash, onSelect: a.onCountExactly }] : []),
    ...(a.export ? [{ label: "Export", icon: ArrowRightFromLine, onSelect: () => setExportList(true), sub: true, disabled: !!a.export.unavailable }] : []),
    "separator",
    { label: "Undo", icon: Undo2, onSelect: a.onUndo, disabled: !a.edit?.canUndo },
    { label: "Redo", icon: Redo2, onSelect: a.onRedo, disabled: !a.edit?.canRedo },
    { label: "Revert all changes", icon: Undo2, onSelect: a.onRevert, disabled: !shown.revert },
    ...(a.onToggleReadonly
      ? [a.readonly
        ? { label: "Allow writes", icon: ShieldOff, onSelect: a.onToggleReadonly, hint: "Read-only now" }
        : { label: "Make read-only", icon: ShieldCheck, onSelect: a.onToggleReadonly, hint: "Writes allowed now" }]
      : []),
  ];

  return (
    <>
      <button
        type="button" onClick={() => setOpen(true)} aria-haspopup="menu" aria-expanded={open} aria-label="Table actions"
        className="grid size-11 shrink-0 place-items-center rounded-md text-text-2 active:bg-surface-hover"
      >
        <MoreVertical className="size-5" />
      </button>
      <BottomSheet open={open} onClose={close}>
        <div role="menu" aria-label={exportList ? "Export" : `${a.table}: table actions`} className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto px-2 pb-2">
          {exportList ? (
            <>
              <SheetRow onClick={() => setExportList(false)}>
                <ChevronLeft className="size-5 text-text-subtle" aria-hidden /><span className="flex-1">Back</span>
              </SheetRow>
              <div role="separator" className="my-1 h-px bg-border" />
              {/* The sheet goes at once: the export's toast says how it went. */}
              {a.export?.run && GRID_EXPORT_FORMATS.map((f) => (
                <SheetRow key={f.id} disabled={a.export!.busy} onClick={() => { close(); void a.export!.run?.(f.id); }}>
                  <span className="size-5" aria-hidden /><span className="flex-1">{f.label}</span>
                </SheetRow>
              ))}
            </>
          ) : items.map((item, i) => {
            if (item === "separator") return <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-border" />;
            const Icon = item.icon;
            return (
              <SheetRow key={item.label} disabled={item.disabled} onClick={() => { if (item.sub) return item.onSelect(); close(); item.onSelect(); }}>
                <Icon className="size-5 text-text-subtle" aria-hidden />
                <span className="flex-1">{item.label}</span>
                {item.hint && <span className="text-xs text-text-subtle">{item.hint}</span>}
                {item.sub && <ChevronRight className="size-4 text-text-subtle" aria-hidden />}
              </SheetRow>
            );
          })}
        </div>
      </BottomSheet>
    </>
  );
}

function SheetRow({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button" role="menuitem" disabled={disabled} onClick={onClick}
      className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm select-none active:bg-accent disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** A phone's thumb bar, over the bottom nav: New row, the panel's sheet, and Save with its count. */
export function TableThumbBar({ actions: a, onOpenPanel }: { actions: TableActions; onOpenPanel?: () => void }) {
  const save = saveButtonState(a.edit, a.readonly);
  const shown = tableButtons(a);
  if (!shown.newRow && !onOpenPanel && a.readonly) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border bg-panel px-2.5 py-2">
      {shown.newRow && (
        <button type="button" onClick={a.onNewRow} aria-label="New row" className="grid size-11 shrink-0 place-items-center rounded-[10px] border border-border text-text-2 active:bg-surface-hover">
          <Plus className="size-5" />
        </button>
      )}
      {onOpenPanel && (
        <button type="button" onClick={onOpenPanel} className="flex h-11 shrink-0 items-center gap-2 rounded-[10px] border border-border px-3.5 text-sm text-text-2 active:bg-surface-hover">
          <Filter className="size-4" aria-hidden />Filters
        </button>
      )}
      <button
        type="button" onClick={a.onSave} disabled={save.disabled}
        aria-label={save.count ? `Save ${save.count} changed ${save.count === 1 ? "row" : "rows"}` : a.readonly ? "Save: the connection is read-only" : "Save"}
        className="flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-[10px] bg-primary px-3.5 text-sm font-medium text-primary-foreground disabled:opacity-45"
      >
        <Save className="size-4" aria-hidden />Save
        {save.count > 0 && <span aria-hidden className="rounded-full bg-white/20 px-1.5 font-mono text-xs">{countBadge(save.count)}</span>}
      </button>
    </div>
  );
}
