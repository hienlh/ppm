/**
 * DBGate's Configure columns: which columns of a row go out, under what names, in what order.
 * Use · Source column · Target column · Remove, and OK, Close, Add column, Reset — Reset greyed
 * until the list differs from what it would put back, OK greyed while the list says why it
 * cannot be used. Both column boxes offer the names known on their side with a ▾: a table's
 * columns, and for an import the file's own, read as Preview reads them (DBGate knows none of a
 * file's and leaves them to be typed). OK on an empty list, or on the one Reset gives, keeps
 * nothing: the row's columns are then copied as they are.
 */
import { useEffect, useState } from "react";
import { AlertCircle, ChevronDown, Loader2 } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { targetUrl } from "@/lib/db-tabs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { columnMapProblem, type ColumnMapEntry, type ImportPreview } from "../../../../shared/db-impexp";
import { linkButtonClass } from "../explorer/tree-parts";
import { FilterDialogFrame } from "../grid/filter-dialog-frame";
import {
  confirmedColumnMap, isFileSource, resetColumnMap, rowTarget, sameColumnMap, type ImpExpForm, type ImpExpRow,
} from "./impexp-state";
import type { ImpExpDbContext } from "./use-impexp-database";
import { cellInputClass } from "./impexp-parts";

interface Known {
  source: string[] | null;
  target: string[] | null;
}

/** The columns each side of `row` is known to have; null for a side that knows none. */
async function knownColumns(form: ImpExpForm, row: ImpExpRow, ctx: ImpExpDbContext): Promise<Known> {
  const tableColumns = async (name: string, tablesOnly: boolean): Promise<string[] | null> => {
    const lower = name.toLowerCase();
    const found = ctx.relations.find((r) => r.name.toLowerCase() === lower && (!tablesOnly || r.kind === "table"));
    if (!found || !ctx.target) return null;
    const schema = found.schema ? `&schema=${encodeURIComponent(found.schema)}` : "";
    const columns = await api.get<{ name: string }[]>(targetUrl(ctx.target, `/schema?table=${encodeURIComponent(found.name)}${schema}`));
    return columns.map((c) => c.name);
  };
  const quietly = <T,>(p: Promise<T>) => p.catch(() => null);
  if (!isFileSource(form.sourceType)) {
    // A grid's query is named after its table, which is how DBGate finds a query's columns too.
    return { source: await quietly(tableColumns(row.source, false)), target: null };
  }
  const [source, target] = await Promise.all([
    row.upload
      ? quietly(api.post<ImportPreview>(`/api/db/impexp/uploads/${encodeURIComponent(row.upload.id)}/preview`, {
        format: form.sourceType, options: form.importOptions,
      }).then((p) => p.columns))
      : Promise.resolve(null),
    quietly(tableColumns(rowTarget(form, row), true)),
  ]);
  return { source, target };
}

export function ColumnsDialog({ form, row, ctx, onConfirm, onClose }: {
  form: ImpExpForm;
  row: ImpExpRow;
  ctx: ImpExpDbContext;
  onConfirm: (columns: ColumnMapEntry[] | undefined) => void;
  onClose: () => void;
}) {
  const [known, setKnown] = useState<Known | null>(null);
  const [value, setValue] = useState<ColumnMapEntry[]>([]);
  useEffect(() => {
    let live = true;
    void knownColumns(form, row, ctx).then((k) => {
      if (!live) return;
      setKnown(k);
      setValue(row.columns?.length ? row.columns : resetColumnMap(k.source, k.target));
    });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = known ? resetColumnMap(known.source, known.target) : [];
  const problem = known ? columnMapProblem(value) : null;
  const differs = !sameColumnMap(value, reset);
  const setAt = (i: number, change: Partial<ColumnMapEntry>) => setValue((v) => v.map((e, j) => (j === i ? { ...e, ...change } : e)));

  return (
    <FilterDialogFrame
      title="Configure columns" description={`Which columns of ${row.source} are written, and under what names`}
      okDisabled={!known || !!problem}
      onOk={() => { onConfirm(confirmedColumnMap(value, reset)); onClose(); }}
      onClose={onClose} className="sm:max-w-[640px]"
      extraButton={(cls) => (
        <>
          <Button type="button" size="sm" variant="outline" className={cls} disabled={!known} onClick={() => setValue((v) => [...v, { src: "", dst: "" }])}>
            Add column
          </Button>
          <Button type="button" size="sm" variant="outline" className={cls} disabled={!known || !differs} onClick={() => setValue(reset)}>
            Reset
          </Button>
        </>
      )}
    >
      {!known ? (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-text-subtle" role="status">
          <Loader2 className="size-4 animate-spin" />Reading the columns…
        </div>
      ) : (
        <>
          {reset.length === 0 && (
            <p className="text-xs text-text-2">When no columns are defined in this mapping, source row is copied to target without any modifications</p>
          )}
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {["Use", "Source column", "Target column", ""].map((h, i) => (
                  <th key={i} className={cn("h-7 border border-border bg-panel-2 px-2 text-left font-medium text-text-2", i === 0 && "w-12", i === 3 && "w-20")}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.map((e, i) => (
                <tr key={i}>
                  <td className="border border-border px-2 text-center">
                    <input
                      type="checkbox" checked={!e.skip} aria-label={`Use ${e.src || `row ${i + 1}`}`} className="size-[15px] accent-primary"
                      onChange={(ev) => setAt(i, { skip: !ev.target.checked })}
                    />
                  </td>
                  <td className="border border-border px-1.5 py-1">
                    <ColumnBox label={`Source column of row ${i + 1}`} value={e.src} known={known.source} onChange={(src) => setAt(i, { src })} />
                  </td>
                  <td className="border border-border px-1.5 py-1">
                    <ColumnBox label={`Target column of row ${i + 1}`} value={e.dst} known={known.target} onChange={(dst) => setAt(i, { dst })} />
                  </td>
                  <td className="border border-border px-2">
                    <button type="button" className={cn(linkButtonClass, "text-xs")} onClick={() => setValue((v) => v.filter((_, j) => j !== i))}>Remove</button>
                  </td>
                </tr>
              ))}
              {value.length === 0 && (
                <tr><td colSpan={4} className="h-8 border border-border px-2 text-center text-text-subtle">No transform defined</td></tr>
              )}
            </tbody>
          </table>
          {problem && (
            <p role="alert" className="flex items-start gap-1.5 text-xs text-error">
              <AlertCircle className="mt-px size-3.5 shrink-0" />{problem}
            </p>
          )}
        </>
      )}
    </FilterDialogFrame>
  );
}

/** A column's name as typed, with a ▾ of the names that side is known to have. */
function ColumnBox({ label, value, known, onChange }: { label: string; value: string; known: string[] | null; onChange: (name: string) => void }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <input aria-label={label} value={value} spellCheck={false} autoComplete="off" onChange={(e) => onChange(e.target.value)} className={cellInputClass} />
      {known && known.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`Choose the ${label.toLowerCase()}`} className="grid h-[26px] w-6 shrink-0 place-items-center rounded-[5px] border border-border text-text-2 can-hover:hover:bg-surface-hover">
              <ChevronDown className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          {/* Enter on an item is the item's, not the dialog's OK. */}
          <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto" onKeyDown={(e) => e.stopPropagation()}>
            {known.map((c) => <DropdownMenuItem key={c} onSelect={() => onChange(c)}>{c}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
