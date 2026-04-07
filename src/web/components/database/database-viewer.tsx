import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Database, Loader2, Play, ChevronLeft, ChevronRight, RefreshCw, Trash2 } from "lucide-react";
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from "@tanstack/react-table";
import CodeMirror from "@uiw/react-codemirror";
import { sql, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import { useDatabase, type DbColumnInfo, type DbQueryResult } from "./use-database";

const SQL_DIALECTS: Record<string, typeof PostgreSQL> = { postgres: PostgreSQL, sqlite: SQLite };

interface Props { metadata?: Record<string, unknown>; tabId?: string }

/** Generic database viewer — works for any DB type via unified API */
export function DatabaseViewer({ metadata }: Props) {
  const connectionId = metadata?.connectionId as number;
  const connectionName = metadata?.connectionName as string | undefined;
  const dbType = (metadata?.dbType as string) ?? "postgres";
  const initialTable = metadata?.tableName as string | undefined;
  const initialSchema = (metadata?.schemaName as string) ?? "public";

  const db = useDatabase(connectionId);
  const [queryPanelOpen, setQueryPanelOpen] = useState(false);

  // Jump to initial table
  const didInit = useRef(false);
  useEffect(() => {
    if (!initialTable || didInit.current) return;
    didInit.current = true;
    db.selectTable(initialTable, initialSchema);
  }, [initialTable, initialSchema]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background shrink-0">
          <Database className="size-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground truncate">{connectionName ?? "Database"}</span>
          {db.selectedTable && <span className="text-xs text-muted-foreground">/ {db.selectedTable}</span>}
          <div className="ml-auto flex items-center gap-1">
            <button type="button" onClick={() => db.refreshData()} title="Reload data"
              className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors">
              <RefreshCw className={`size-3 ${db.loading ? "animate-spin" : ""}`} />
            </button>
            <button type="button" onClick={() => setQueryPanelOpen((v) => !v)}
              className={`px-2 py-1 rounded text-xs transition-colors ${queryPanelOpen ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              SQL
            </button>
          </div>
        </div>

        {/* Data grid */}
        <div className={`flex-1 overflow-hidden ${queryPanelOpen ? "max-h-[60%]" : ""}`}>
          <DataGrid tableData={db.tableData} schema={db.schema} loading={db.loading}
            page={db.page} onPageChange={db.setPage} onCellUpdate={db.updateCell} onRowDelete={db.deleteRow} />
        </div>

        {/* Query editor */}
        {queryPanelOpen && (
          <div className="border-t border-border h-[40%] shrink-0">
            <QueryEditor dialect={SQL_DIALECTS[dbType] ?? PostgreSQL}
              onExecute={db.executeQuery} result={db.queryResult} error={db.queryError} loading={db.queryLoading} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Data Grid ---------- */
function DataGrid({ tableData, schema, loading, page, onPageChange, onCellUpdate, onRowDelete }: {
  tableData: { columns: string[]; rows: Record<string, unknown>[]; total: number; limit: number } | null;
  schema: DbColumnInfo[]; loading: boolean; page: number;
  onPageChange: (p: number) => void;
  onCellUpdate: (pkCol: string, pkVal: unknown, col: string, val: unknown) => void;
  onRowDelete?: (pkCol: string, pkVal: unknown) => void;
}) {
  const [editingCell, setEditingCell] = useState<{ rowIdx: number; col: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState<number | null>(null);

  const pkCol = useMemo(() => schema.find((c) => c.pk)?.name ?? null, [schema]);

  const startEdit = useCallback((rowIdx: number, col: string, val: unknown) => {
    setEditingCell({ rowIdx, col });
    setEditValue(val == null ? "" : String(val));
  }, []);

  const commitEdit = useCallback(() => {
    if (!editingCell || !tableData || !pkCol) return;
    const row = tableData.rows[editingCell.rowIdx];
    if (!row) return;
    const oldVal = row[editingCell.col];
    if (String(oldVal ?? "") !== editValue) {
      onCellUpdate(pkCol, row[pkCol], editingCell.col, editValue === "" ? null : editValue);
    }
    setEditingCell(null);
  }, [editingCell, editValue, tableData, pkCol, onCellUpdate]);

  const cancelEdit = useCallback(() => setEditingCell(null), []);

  const handleDelete = useCallback((rowIdx: number) => {
    if (!tableData || !pkCol || !onRowDelete) return;
    const row = tableData.rows[rowIdx];
    if (!row) return;
    onRowDelete(pkCol, row[pkCol]);
    setConfirmDeleteIdx(null);
  }, [tableData, pkCol, onRowDelete]);

  const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
    const dataCols: ColumnDef<Record<string, unknown>>[] = (tableData?.columns ?? []).map((col) => ({
      id: col,
      accessorFn: (row) => row[col],
      header: () => <span className={schema.find((c) => c.name === col)?.pk ? "font-bold" : ""}>{col}</span>,
      cell: ({ row, getValue }) => {
        const isEditing = editingCell?.rowIdx === row.index && editingCell?.col === col;
        const val = getValue();
        if (isEditing) {
          return (
            <input autoFocus className="w-full bg-transparent border border-primary/50 rounded px-1 py-0 text-xs outline-none"
              value={editValue} onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitEdit} onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") cancelEdit(); }} />
          );
        }
        return (
          <span className={`cursor-pointer truncate block ${val == null ? "text-muted-foreground/40 italic" : ""}`}
            onDoubleClick={() => pkCol && startEdit(row.index, col, val)} title={val == null ? "NULL" : String(val)}>
            {val == null ? "NULL" : String(val)}
          </span>
        );
      },
    }));

    if (onRowDelete && pkCol) {
      dataCols.push({
        id: "_actions",
        header: () => null,
        cell: ({ row }) => {
          const rowIdx = row.index;
          const isConfirming = confirmDeleteIdx === rowIdx;
          if (isConfirming) {
            return (
              <span className="flex items-center gap-1 whitespace-nowrap">
                <button type="button" onClick={() => handleDelete(rowIdx)}
                  className="text-destructive text-[10px] font-medium hover:underline">Confirm</button>
                <button type="button" onClick={() => setConfirmDeleteIdx(null)}
                  className="text-muted-foreground text-[10px] hover:underline">Cancel</button>
              </span>
            );
          }
          return (
            <button type="button" onClick={() => setConfirmDeleteIdx(rowIdx)}
              className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity"
              title="Delete row">
              <Trash2 className="size-3" />
            </button>
          );
        },
        size: 60,
      });
    }

    return dataCols;
  },
  [tableData?.columns, schema, editingCell, editValue, commitEdit, cancelEdit, startEdit, pkCol, onRowDelete, confirmDeleteIdx, handleDelete]);

  const table = useReactTable({ data: tableData?.rows ?? [], columns, getCoreRowModel: getCoreRowModel() });

  if (!tableData) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        {loading ? <Loader2 className="size-4 animate-spin" /> : "Select a table"}
      </div>
    );
  }

  const totalPages = Math.ceil(tableData.total / tableData.limit) || 1;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10 bg-muted">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id} className="px-2 py-1.5 text-left font-medium text-muted-foreground border-b border-border whitespace-nowrap">
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="group hover:bg-muted/30 border-b border-border/50">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-2 py-1 max-w-[300px]">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {tableData.rows.length === 0 && (
              <tr><td colSpan={tableData.columns.length} className="px-2 py-8 text-center text-muted-foreground">No data</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border bg-background shrink-0 text-xs text-muted-foreground">
        <span>{tableData.total.toLocaleString()} rows</span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="p-0.5 rounded hover:bg-muted disabled:opacity-30">
            <ChevronLeft className="size-3.5" />
          </button>
          <span>{page} / {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} className="p-0.5 rounded hover:bg-muted disabled:opacity-30">
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Query Editor ---------- */
function QueryEditor({ dialect, onExecute, result, error, loading }: {
  dialect: typeof PostgreSQL; onExecute: (sql: string) => void; result: DbQueryResult | null; error: string | null; loading: boolean;
}) {
  const [query, setQuery] = useState("SELECT * FROM ");

  const handleExecute = useCallback(() => { const t = query.trim(); if (t) onExecute(t); }, [query, onExecute]);
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); handleExecute(); }
  }, [handleExecute]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-start gap-1 border-b border-border bg-background" onKeyDown={handleKeyDown}>
        <div className="flex-1 max-h-[120px] overflow-auto">
          <CodeMirror value={query} onChange={setQuery} extensions={[sql({ dialect })]}
            basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
            className="text-xs [&_.cm-editor]:!outline-none [&_.cm-scroller]:!overflow-auto" />
        </div>
        <button type="button" onClick={handleExecute} disabled={loading} title="Execute (Cmd+Enter)"
          className="shrink-0 m-1 p-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors">
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
        </button>
      </div>
      <div className="flex-1 overflow-auto text-xs">
        {error && <div className="px-3 py-2 text-destructive bg-destructive/5">{error}</div>}
        {result?.changeType === "modify" && <div className="px-3 py-2 text-green-500">Query executed. {result.rowsAffected} row(s) affected.</div>}
        {result?.changeType === "select" && result.rows.length > 0 && (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-muted">
              <tr>{result.columns.map((c) => <th key={c} className="px-2 py-1 text-left font-medium text-muted-foreground border-b border-border whitespace-nowrap">{c}</th>)}</tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} className="hover:bg-muted/30 border-b border-border/50">
                  {result.columns.map((c) => (
                    <td key={c} className="px-2 py-1 max-w-[300px] truncate" title={row[c] == null ? "NULL" : String(row[c])}>
                      {row[c] == null ? <span className="text-muted-foreground/40 italic">NULL</span> : String(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {result?.changeType === "select" && result.rows.length === 0 && <div className="px-3 py-2 text-muted-foreground">No results</div>}
      </div>
    </div>
  );
}
