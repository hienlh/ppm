/**
 * One result tab: the rows in the data grid of phase 04 — read-only unless they are one table's
 * rows by its primary key — and under it what they are: how many, how long the statement took,
 * which statement and lines they came from, whether the row limit cut them short, and why they
 * cannot be edited when they cannot.
 */
import { useEffect, useMemo, useState } from "react";
import { Lock, TriangleAlert } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { targetUrl, type DbTarget } from "@/lib/db-tabs";
import { rowsToRecords } from "../../../../shared/db-grid";
import type { DialectName } from "../../../../shared/db-types";
import type { QueryResultSet, QueryStatementResult } from "../../../../shared/db-query-script";
import type { DbColumnInfo } from "../use-database";
import type { GridChanges, GridColumnSchema } from "../glide-grid-types";
import type { GridExport } from "../export-button";
import { GlideDataGrid } from "../glide-data-grid";
import { extractQueryTable } from "../extract-query-table";
import { countOf, resultEditability, type QueryResultTab } from "./query-run-state";

export function ResultView({
  tab, result, set, target, readonly, explain, connectionName, dialect, tabId, rereading, onSave, exporter,
}: {
  tab: QueryResultTab;
  result: QueryStatementResult;
  set: QueryResultSet;
  target: DbTarget | null;
  readonly: boolean;
  explain: boolean;
  connectionName?: string;
  dialect?: DialectName;
  tabId?: string;
  /** Its rows are being read again after a save. */
  rereading: boolean;
  onSave: (table: { table: string; schema: string }, changes: GridChanges) => Promise<void>;
  exporter?: GridExport;
}) {
  // Rows as objects under unique keys: `SELECT 1 a, 2 a` shows both columns.
  const { keys, records } = useMemo(() => rowsToRecords(set.columns, set.rows), [set]);
  const names = useMemo(() => set.columns.map((c) => c.name), [set]);
  const table = useMemo(() => (explain ? null : extractQueryTable(result.sql, "")), [result.sql, explain]);
  const tableColumns = useTableColumns(readonly || explain ? null : target, table);
  const edit = useMemo(
    () => resultEditability({ readonly, explain, table, tableColumns, columns: names }),
    [readonly, explain, table, tableColumns, names],
  );

  const schema = useMemo<GridColumnSchema[]>(() => (edit.editable
    ? edit.schema
    : set.columns.map((c, i) => ({ name: keys[i]!, type: c.type, nullable: true, pk: false, defaultValue: null }))
  ), [edit, set, keys]);

  const lines = result.startLine === result.endLine ? `line ${result.startLine}` : `lines ${result.startLine}–${result.endLine}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden">
        <GlideDataGrid
          columns={keys} rows={records} schema={schema} loading={rereading}
          rowKey={edit.editable ? edit.rowKey : []} editOnly readOnly={!edit.editable}
          onSaveChanges={edit.editable && table ? (changes) => onSave(table, changes) : undefined}
          connectionName={connectionName} dialect={dialect} tabId={tabId} tabSlot={tab.key}
          exporter={exporter}
        />
      </div>
      <div
        className={cn(
          "flex h-6 shrink-0 items-center gap-2 overflow-hidden border-t border-border px-3 text-[11px] whitespace-nowrap text-text-subtle",
          "max-md:h-8 max-md:text-xs",
        )}
      >
        <span className="text-text-2">{countOf(set.rows.length, "row")}</span>
        <span className="font-mono">{result.durationMs.toLocaleString("en-US")} ms</span>
        <span className="truncate max-md:hidden">· statement {result.index + 1}, {lines}</span>
        {set.truncated && (
          <span className="flex items-center gap-1 text-warning" title="Raise the row limit in the toolbar to read more">
            <TriangleAlert aria-hidden className="size-3.5" />Cut off at {set.rows.length.toLocaleString("en-US")} rows
          </span>
        )}
        <span className="flex-1" />
        {!edit.editable && edit.reason && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-px"
            title="A result can be edited only when it holds one table's rows, its primary key among them"
          >
            <Lock aria-hidden className="size-3" />{edit.reason}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The columns of `table`, which say whether the result can be saved back to it: undefined while
 * they are read, null when they could not be — and undefined for good where there is no table.
 */
function useTableColumns(target: DbTarget | null, table: { table: string; schema: string } | null): DbColumnInfo[] | null | undefined {
  const [columns, setColumns] = useState<{ key: string; cols: DbColumnInfo[] | null } | null>(null);
  const key = target && table ? JSON.stringify([target, table]) : null;
  useEffect(() => {
    if (!target || !table || !key) return;
    let live = true;
    const schema = table.schema ? `&schema=${encodeURIComponent(table.schema)}` : "";
    api.get<DbColumnInfo[]>(targetUrl(target, `/schema?table=${encodeURIComponent(table.table)}${schema}`))
      .then((cols) => { if (live) setColumns({ key, cols }); })
      .catch(() => { if (live) setColumns({ key, cols: null }); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return columns && columns.key === key ? columns.cols : undefined;
}
