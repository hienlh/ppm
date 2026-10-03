/**
 * DBGate's Map source tables/files: a row per table, query or file — its Source with the trash can
 * that takes it out, an import's Action, the Target it writes to (the default shown until another
 * name is typed; an import's ▾ lists the tables already there), an import's Preview tick, the
 * Status of the last run, and the Columns link that opens Configure columns.
 */
import { AlertCircle, CheckCircle2, ChevronDown, Clock, Info, Loader2, Square, Table, Trash2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatBytes } from "@/lib/format-bytes";
import { IMPORT_ACTIONS, type ImpExpItemStatus, type ImportAction } from "../../../../shared/db-impexp";
import { linkButtonClass } from "../explorer/tree-parts";
import {
  TEMPLATE_SOURCE, columnsLinkText, defaultRowTarget, isFileSource, itemStatusText, removeRow, rowSourceLabel, updateRow,
  type ImpExpForm, type ImpExpRow,
} from "./impexp-state";
import { ConfigTitle, cellInputClass } from "./impexp-parts";

type FormChange = (change: (form: ImpExpForm) => ImpExpForm) => void;

const th = "h-7 border border-border bg-panel-2 px-2 text-left text-xs font-medium whitespace-nowrap text-text-2";
const td = "h-[34px] border border-border px-2 py-1 align-middle text-xs text-text-primary";

export function MapTable({ form, items, existingTables, preview, onPreview, onForm, onColumns, onError }: {
  form: ImpExpForm;
  /** The last run's progress by row, once there has been one. */
  items: Map<string, ImpExpItemStatus> | null;
  /** The target database's tables, for an import's ▾. */
  existingTables: readonly string[];
  /** The row whose first rows the Preview pane shows. */
  preview: string | null;
  onPreview: (source: string | null) => void;
  onForm: FormChange;
  onColumns: (source: string) => void;
  onError: (item: ImpExpItemStatus) => void;
}) {
  const importing = isFileSource(form.sourceType);
  const columnCount = 3 + (importing ? 2 : 0) + (items ? 1 : 0);
  return (
    <section aria-label="Map source tables/files" className="px-4 pb-4">
      <ConfigTitle icon={Table}>Map source tables/files</ConfigTitle>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={th}>Source</th>
            {importing && <th className={cn(th, "w-[170px]")}>Action</th>}
            <th className={th}>Target</th>
            {importing && <th className={cn(th, "w-[64px]")}>Preview</th>}
            {items && <th className={cn(th, "w-[150px]")}>Status</th>}
            <th className={cn(th, "w-[130px]")}>Columns</th>
          </tr>
        </thead>
        <tbody>
          {form.rows.map((row) => (
            <MapRow
              key={row.source} form={form} row={row} importing={importing} item={items ? items.get(row.source) ?? null : undefined}
              existingTables={existingTables} previewed={preview === row.source} onPreview={onPreview}
              onForm={onForm} onColumns={onColumns} onError={onError}
            />
          ))}
          {form.rows.length === 0 && (
            <tr>
              <td colSpan={columnCount} className={cn(td, "text-center text-text-subtle")}>
                {importing ? "Upload the files to import" : "Choose the tables or views to export"}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function MapRow({ form, row, importing, item, existingTables, previewed, onPreview, onForm, onColumns, onError }: {
  form: ImpExpForm;
  row: ImpExpRow;
  importing: boolean;
  /** undefined: no run yet, so no Status column; null: this row was not in the last run. */
  item: ImpExpItemStatus | null | undefined;
  existingTables: readonly string[];
  previewed: boolean;
  onPreview: (source: string | null) => void;
  onForm: FormChange;
  onColumns: (source: string) => void;
  onError: (item: ImpExpItemStatus) => void;
}) {
  const label = rowSourceLabel(row);
  const named = row.source === TEMPLATE_SOURCE ? "the row with no file yet" : label;
  return (
    <tr>
      <td className={td}>
        <div className="flex min-w-0 items-center justify-between gap-1.5">
          <span
            className={cn("min-w-0 truncate", row.source === TEMPLATE_SOURCE && "text-text-subtle italic")}
            title={row.upload ? `${row.upload.name} (${formatBytes(row.upload.size)})` : label}
          >
            {label}
          </span>
          <button
            type="button" aria-label={`Remove ${named}`} title="Remove"
            onClick={() => onForm((f) => removeRow(f, row.source))}
            className="grid size-6 shrink-0 place-items-center rounded text-primary can-hover:hover:bg-surface-hover"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </td>
      {importing && (
        <td className={td}>
          <select
            aria-label={`Action for ${named}`} value={row.action ?? "createTable"}
            onChange={(e) => onForm((f) => updateRow(f, row.source, { action: e.target.value as ImportAction }))}
            className={cn(cellInputClass, "cursor-pointer pr-1")}
          >
            {IMPORT_ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </td>
      )}
      <td className={td}>
        <div className="flex min-w-0 items-center gap-1">
          <input
            aria-label={`Target of ${named}`} value={row.target ?? defaultRowTarget(form, row)} spellCheck={false} autoComplete="off"
            onChange={(e) => onForm((f) => updateRow(f, row.source, { target: e.target.value }))}
            className={cellInputClass}
          />
          {importing && existingTables.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={`Choose a table for ${named}`} title="Choose a table" className="grid h-[26px] w-6 shrink-0 place-items-center rounded-[5px] border border-border text-text-2 can-hover:hover:bg-surface-hover">
                  <ChevronDown className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                {existingTables.map((t) => (
                  <DropdownMenuItem key={t} onSelect={() => onForm((f) => updateRow(f, row.source, { target: t }))}>{t}</DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </td>
      {importing && (
        <td className={cn(td, "text-center")}>
          {row.upload && (
            <input
              type="checkbox" aria-label={`Preview ${named}`} checked={previewed}
              onChange={(e) => onPreview(e.target.checked ? row.source : null)} className="size-[15px] accent-primary"
            />
          )}
        </td>
      )}
      {item !== undefined && <td className={td}>{item && <StatusCell item={item} onError={onError} />}</td>}
      <td className={td}>
        <button type="button" className={cn(linkButtonClass, "text-xs")} onClick={() => onColumns(row.source)}>
          {columnsLinkText(row.columns)}
        </button>
      </td>
    </tr>
  );
}

function StatusCell({ item, onError }: { item: ImpExpItemStatus; onError: (item: ImpExpItemStatus) => void }) {
  const Icon = { queued: Clock, running: Loader2, done: CheckCircle2, error: AlertCircle, stopped: Square }[item.state];
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          item.state === "running" && "animate-spin text-text-2",
          item.state === "done" && "text-success",
          item.state === "error" && "text-destructive",
          (item.state === "queued" || item.state === "stopped") && "text-text-subtle",
        )}
      />
      <span className="truncate tabular-nums">{itemStatusText(item)}</span>
      {item.state === "error" && item.error && (
        <button
          type="button" aria-label="Show the error" title={item.error} onClick={() => onError(item)}
          className="grid size-5 shrink-0 place-items-center rounded text-info can-hover:hover:bg-surface-hover"
        >
          <Info className="size-3.5" />
        </button>
      )}
    </span>
  );
}
