import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Database, RefreshCw, GripHorizontal, Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { useDatabase, type DbColumnInfo } from "./use-database";
import { SqlQueryEditor } from "./sql-query-editor";
import { ExportButton } from "./export-button";
import { GlideDataGrid } from "./glide-data-grid";
import type { SchemaInfo } from "./sql-completion-provider";

/** Parse WHERE "col" ILIKE '%val%' clauses from SQL */
function parseSqlFilters(sql: string): Record<string, string> {
  const filters: Record<string, string> = {};
  const re = /"(\w+)"\s+ILIKE\s+'%([^']*?)%'/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    filters[m[1]!] = m[2]!.replace(/''/g, "'");
  }
  return filters;
}

interface Props { metadata?: Record<string, unknown>; tabId?: string }

/** Generic database viewer — works for any DB type via unified API */
export function DatabaseViewer({ metadata, tabId }: Props) {
  const connectionId = metadata?.connectionId as number;
  const connectionName = metadata?.connectionName as string | undefined;
  const initialTable = metadata?.tableName as string | undefined;
  const initialSchema = (metadata?.schemaName as string) ?? "public";
  const initialSql = metadata?.initialSql as string | undefined;
  const persistedSql = metadata?.currentSql as string | undefined;

  // Persist SQL text to tab metadata (debounced via updateTab's built-in persist)
  const updateTab = useTabStore((s) => s.updateTab);
  const metadataRef = useRef(metadata);
  metadataRef.current = metadata;
  const handleSqlChange = useCallback((sql: string) => {
    if (!tabId) return;
    updateTab(tabId, { metadata: { ...metadataRef.current, currentSql: sql } });
  }, [tabId, updateTab]);

  const db = useDatabase(connectionId);
  const [cachedTableNames, setCachedTableNames] = useState<{ name: string; schema: string }[]>([]);
  const [queryHeight, setQueryHeight] = useState(180);
  const containerRef = useRef<HTMLDivElement>(null);

  // Column ILIKE filters from DataGrid header
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});

  // Build query text reflecting current table state (sort, page, filters)
  const defaultQuery = useMemo(() => {
    if (initialSql && !db.selectedTable) return initialSql;
    if (db.selectedTable) {
      let sql = `SELECT * FROM "${db.selectedTable}"`;
      const whereParts = Object.entries(columnFilters)
        .filter(([, v]) => v.trim())
        .map(([col, v]) => `"${col}" ILIKE '%${v.replace(/'/g, "''")}%'`);
      if (whereParts.length > 0) sql += ` WHERE ${whereParts.join(" AND ")}`;
      if (db.orderBy) sql += ` ORDER BY "${db.orderBy}" ${db.orderDir}`;
      const offset = (db.page - 1) * 100;
      sql += ` LIMIT 100`;
      if (offset > 0) sql += ` OFFSET ${offset}`;
      return sql;
    }
    return "SELECT * FROM ";
  }, [initialSql, db.selectedTable, db.orderBy, db.orderDir, db.page, columnFilters]);

  // When column filters change, auto-execute the query with debounce
  const handleColumnFilter = useCallback((filters: Record<string, string>) => {
    setColumnFilters(filters);
  }, []);
  const filterTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!db.selectedTable || Object.keys(columnFilters).length === 0) return;
    clearTimeout(filterTimerRef.current);
    filterTimerRef.current = setTimeout(() => {
      // Execute filter query into tableData — stays in table grid mode
      db.queryAsTable(defaultQuery);
    }, 500);
    return () => clearTimeout(filterTimerRef.current);
  }, [columnFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag resize handler
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = queryHeight;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY;
      const newH = Math.max(80, Math.min(startH + delta, (containerRef.current?.clientHeight ?? 600) - 100));
      setQueryHeight(newH);
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [queryHeight]);

  // Fetch table names for autocomplete once on mount
  useEffect(() => {
    api.get<{ name: string; schema: string; rowCount: number }[]>(`/api/db/connections/${connectionId}/tables?cached=1`)
      .then((tables) => setCachedTableNames(tables.map((t) => ({ name: t.name, schema: t.schema }))))
      .catch(() => {});
  }, [connectionId]);

  // Build SchemaInfo for autocomplete
  const schemaInfo = useMemo<SchemaInfo | undefined>(() => {
    if (cachedTableNames.length === 0) return undefined;
    return {
      tables: cachedTableNames,
      getColumns: async (table: string, schema?: string) => {
        const cols = await api.get<{ name: string; type: string }[]>(
          `/api/db/connections/${connectionId}/schema?table=${encodeURIComponent(table)}${schema ? `&schema=${encodeURIComponent(schema)}` : ""}`,
        );
        return cols;
      },
    };
  }, [connectionId, cachedTableNames]);

  // Jump to initial table
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    if (initialSql) {
      db.executeQuery(initialSql);
    } else if (initialTable) {
      db.selectTable(initialTable, initialSchema);
    }
  }, [initialTable, initialSchema, initialSql]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track whether user ran a custom query (show results instead of table grid)
  const [showingQueryResult, setShowingQueryResult] = useState(!!initialSql);
  const handleExecuteQuery = useCallback((sql: string) => {
    const trimmed = sql.trim();
    // Check if query is a simple SELECT on the current table — stay in table grid mode
    if (db.selectedTable) {
      const tablePattern = new RegExp(`^SELECT\\s+\\*\\s+FROM\\s+"?${db.selectedTable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\b`, "i");
      if (tablePattern.test(trimmed)) {
        // Parse ILIKE filters from SQL and sync to columnFilters
        const parsed = parseSqlFilters(trimmed);
        setColumnFilters(parsed);
        db.queryAsTable(trimmed);
        return;
      }
    }
    setShowingQueryResult(true);
    db.executeQuery(sql);
  }, [db.executeQuery, db.queryAsTable, db.selectedTable]);

  // When user interacts with DataGrid (sort/page), switch back to table view
  const handleToggleSort = useCallback((col: string) => {
    setShowingQueryResult(false);
    db.toggleSort(col);
  }, [db.toggleSort]);
  const handleClearSort = useCallback(() => {
    setShowingQueryResult(false);
    db.clearSort();
  }, [db.clearSort]);
  const handlePageChange = useCallback((p: number) => {
    setShowingQueryResult(false);
    db.setPage(p);
  }, [db.setPage]);

  const qr = db.queryResult;
  const showQueryResults = showingQueryResult && !!(qr || db.queryError);
  const showTableGrid = db.selectedTable && !showQueryResults;

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background shrink-0">
          <Database className="size-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground truncate">{connectionName ?? "Database"}</span>
          {db.selectedTable && <span className="text-xs text-muted-foreground">/ {db.selectedTable}</span>}
          <div className="ml-auto flex items-center gap-1">
            {db.tableData && (
              <ExportButton
                columns={db.tableData.columns}
                rows={db.tableData.rows}
                filename={connectionName ? `${connectionName}-${db.selectedTable ?? "data"}` : db.selectedTable ?? "data"}
                exportAllUrl={db.selectedTable ? `/api/db/connections/${connectionId}/export?table=${encodeURIComponent(db.selectedTable)}&schema=${db.selectedSchema}` : undefined}
              />
            )}
            <button type="button" onClick={() => db.refreshData()} title="Reload data"
              className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors">
              <RefreshCw className={`size-3 ${db.loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* Always-visible query editor at top */}
        <div className="shrink-0 border-b border-border" style={{ height: queryHeight }}>
          <SqlQueryEditor
            onExecute={handleExecuteQuery} loading={db.queryLoading}
            defaultValue={defaultQuery} schemaInfo={schemaInfo}
            onSqlChange={handleSqlChange} persistedSql={persistedSql} />
        </div>

        {/* Resize handle */}
        <div onMouseDown={handleDragStart}
          className="shrink-0 h-1.5 cursor-row-resize bg-border/50 hover:bg-primary/30 flex items-center justify-center transition-colors">
          <GripHorizontal className="size-3 text-muted-foreground/50" />
        </div>

        {/* Bottom panel: table data OR query results */}
        <div className="flex-1 overflow-hidden">
          {showTableGrid && db.tableData && (
            <GlideDataGrid
              columns={db.tableData.columns} rows={db.tableData.rows}
              total={db.tableData.total} limit={db.tableData.limit}
              schema={db.schema} loading={db.loading}
              page={db.page} onPageChange={handlePageChange}
              onCellUpdate={db.updateCell} onRowDelete={db.deleteRow}
              orderBy={db.orderBy} orderDir={db.orderDir} onToggleSort={handleToggleSort} onClearSort={handleClearSort}
              onBulkDelete={db.bulkDelete} onInsertRow={db.insertRow}
              connectionId={connectionId} selectedTable={db.selectedTable} selectedSchema={db.selectedSchema}
              connectionName={connectionName} columnFilters={columnFilters} onColumnFilter={handleColumnFilter} />
          )}

          {showQueryResults && (
            <QueryResultPanel result={qr} error={db.queryError} loading={db.queryLoading} schema={db.schema} connectionName={connectionName} />
          )}
        </div>
      </div>
    </div>
  );
}

const NOOP = () => {};

/** Read-only result panel for ad-hoc query results — uses DataGrid for SELECT to get checkboxes + export */
function QueryResultPanel({ result, error, loading, schema, connectionName }: {
  result: { columns: string[]; rows: Record<string, unknown>[]; rowsAffected: number; changeType: "select" | "modify"; executionTimeMs?: number } | null;
  error: string | null;
  loading?: boolean;
  schema?: DbColumnInfo[];
  connectionName?: string;
}) {
  // Build a read-only DataGrid-compatible tableData from query result
  const queryTableData = useMemo(() => (
    result?.changeType === "select" && result.rows.length > 0
      ? { columns: result.columns, rows: result.rows, total: result.rows.length, limit: result.rows.length }
      : null
  ), [result]);

  // Use schema if available, otherwise build minimal schema from column names
  const querySchema = useMemo(() => (
    schema?.length ? schema : (result?.columns ?? []).map((c) => ({
      name: c, type: "text", nullable: true, pk: false, defaultValue: null,
    }))
  ), [schema, result?.columns]);

  return (
    <div className="flex flex-col h-full overflow-hidden text-xs">
      {error && <div className="px-3 py-2 text-destructive bg-destructive/5 shrink-0">{error}</div>}

      {result?.changeType === "modify" && (
        <div className="px-3 py-2 text-green-500 shrink-0">
          {result.rowsAffected} row(s) affected
          {result.executionTimeMs != null && <span className="text-muted-foreground ml-2">{result.executionTimeMs}ms</span>}
        </div>
      )}

      {queryTableData && (
        <div className="flex-1 overflow-hidden">
          <GlideDataGrid
            columns={queryTableData.columns} rows={queryTableData.rows}
            total={queryTableData.total} limit={queryTableData.limit}
            schema={querySchema} loading={!!loading}
            page={1} onPageChange={NOOP} onCellUpdate={NOOP}
            orderBy={null} orderDir="ASC" onToggleSort={NOOP}
            connectionName={connectionName}
          />
          {result?.executionTimeMs != null && (
            <div className="px-3 py-0.5 border-t border-border text-[10px] text-muted-foreground shrink-0">
              {result.rows.length} rows · {result.executionTimeMs}ms
            </div>
          )}
        </div>
      )}

      {result?.changeType === "select" && result.rows.length === 0 && (
        <div className="px-3 py-2 text-muted-foreground shrink-0">
          No results
          {result.executionTimeMs != null && <span className="ml-2 text-muted-foreground/60">{result.executionTimeMs}ms</span>}
        </div>
      )}

      {!result && !error && (
        <div className="flex items-center justify-center h-full text-muted-foreground">
          {loading ? <Loader2 className="size-4 animate-spin" /> : "Run a query to see results"}
        </div>
      )}
    </div>
  );
}
