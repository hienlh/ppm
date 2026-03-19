import { useState, useCallback, useMemo } from "react";
import { Database, Loader2, AlertCircle, Play, ChevronLeft, ChevronRight, Table, RefreshCw } from "lucide-react";
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from "@tanstack/react-table";
import CodeMirror from "@uiw/react-codemirror";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { usePostgres, type PgColumnInfo, type PgQueryResult } from "./use-postgres";

interface Props { metadata?: Record<string, unknown>; tabId?: string }

export function PostgresViewer({ metadata }: Props) {
  const initialConn = (metadata?.connectionString as string) ?? "";
  const pg = usePostgres();

  if (!pg.connected) return <ConnectionForm initialValue={initialConn} onConnect={pg.connect} loading={pg.loading} error={pg.error} />;

  return <ConnectedView pg={pg} />;
}

/* ---------- Connection Form ---------- */
function ConnectionForm({ initialValue, onConnect, loading, error }: {
  initialValue: string; onConnect: (s: string) => void; loading: boolean; error: string | null;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <div className="flex items-center justify-center h-full">
      <div className="flex flex-col gap-3 w-full max-w-lg px-4">
        <div className="flex items-center gap-2 text-sm font-medium"><Database className="size-4" /> Connect to PostgreSQL</div>
        <input
          className="w-full px-3 py-2 rounded border border-border bg-background text-sm font-mono outline-none focus:border-primary"
          placeholder="postgresql://user:pass@host:5432/db"
          value={value} onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) onConnect(value.trim()); }}
        />
        {error && <p className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="size-3" />{error}</p>}
        <button type="button" disabled={loading || !value.trim()} onClick={() => onConnect(value.trim())}
          className="px-4 py-2 rounded bg-primary text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50 transition-colors">
          {loading ? <Loader2 className="size-4 animate-spin mx-auto" /> : "Connect"}
        </button>
      </div>
    </div>
  );
}

/* ---------- Connected View ---------- */
function ConnectedView({ pg }: { pg: ReturnType<typeof usePostgres> }) {
  const [queryPanelOpen, setQueryPanelOpen] = useState(false);

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Table sidebar */}
      <div className="w-48 shrink-0 flex flex-col bg-background overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tables</span>
          <button type="button" onClick={pg.refreshTables} className="text-muted-foreground hover:text-foreground transition-colors" title="Refresh">
            <RefreshCw className="size-3" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {pg.tables.map((t) => (
            <button key={`${t.schema}.${t.name}`} type="button" onClick={() => pg.selectTable(t.name, t.schema)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                pg.selectedTable === t.name ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}>
              <Table className="size-3 shrink-0" />
              <span className="truncate flex-1">{t.schema !== "public" ? `${t.schema}.` : ""}{t.name}</span>
              <span className="text-[10px] opacity-60">{t.rowCount}</span>
            </button>
          ))}
          {pg.tables.length === 0 && <p className="px-3 py-4 text-xs text-muted-foreground text-center">No tables found</p>}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden border-l border-border">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background shrink-0">
          <Database className="size-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground truncate">PostgreSQL</span>
          {pg.selectedTable && <span className="text-xs text-muted-foreground">/ {pg.selectedTable}</span>}
          <div className="ml-auto">
            <button type="button" onClick={() => setQueryPanelOpen((v) => !v)}
              className={`px-2 py-1 rounded text-xs transition-colors ${queryPanelOpen ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              SQL
            </button>
          </div>
        </div>

        <div className={`flex-1 overflow-hidden ${queryPanelOpen ? "max-h-[60%]" : ""}`}>
          <PgDataGrid tableData={pg.tableData} schema={pg.schema} loading={pg.loading}
            page={pg.page} onPageChange={pg.setPage} onCellUpdate={pg.updateCell} />
        </div>

        {queryPanelOpen && (
          <div className="border-t border-border h-[40%] shrink-0">
            <PgQueryEditor onExecute={pg.executeQuery} result={pg.queryResult} error={pg.queryError} loading={pg.queryLoading} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Data Grid ---------- */
function PgDataGrid({ tableData, schema, loading, page, onPageChange, onCellUpdate }: {
  tableData: { columns: string[]; rows: Record<string, unknown>[]; total: number; limit: number } | null;
  schema: PgColumnInfo[]; loading: boolean; page: number;
  onPageChange: (p: number) => void;
  onCellUpdate: (pkCol: string, pkVal: unknown, col: string, val: unknown) => void;
}) {
  const [editingCell, setEditingCell] = useState<{ rowIdx: number; col: string } | null>(null);
  const [editValue, setEditValue] = useState("");

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

  const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(() =>
    (tableData?.columns ?? []).map((col) => ({
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
    })),
  [tableData?.columns, schema, editingCell, editValue, commitEdit, cancelEdit, startEdit, pkCol]);

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
              <tr key={row.id} className="hover:bg-muted/30 border-b border-border/50">
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
function PgQueryEditor({ onExecute, result, error, loading }: {
  onExecute: (sql: string) => void; result: PgQueryResult | null; error: string | null; loading: boolean;
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
          <CodeMirror value={query} onChange={setQuery} extensions={[sql({ dialect: PostgreSQL })]}
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
