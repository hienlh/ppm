import { useState } from "react";
import { Database, Loader2, AlertCircle } from "lucide-react";
import { useSqlite } from "./use-sqlite";
import { SqliteTableList } from "./sqlite-table-list";
import { SqliteDataGrid } from "./sqlite-data-grid";
import { SqliteQueryEditor } from "./sqlite-query-editor";

interface SqliteViewerProps {
  metadata?: Record<string, unknown>;
  tabId?: string;
}

export function SqliteViewer({ metadata }: SqliteViewerProps) {
  const filePath = metadata?.filePath as string | undefined;
  const projectName = metadata?.projectName as string | undefined;
  const connectionId = metadata?.connectionId as number | undefined;
  const initialTable = metadata?.tableName as string | undefined;
  const [queryPanelOpen, setQueryPanelOpen] = useState(false);

  // Connection-based mode: skip file selection requirement
  if (connectionId) {
    return (
      <SqliteViewerInner
        projectName=""
        dbPath=""
        connectionId={connectionId}
        initialTable={initialTable}
        queryPanelOpen={queryPanelOpen}
        onToggleQueryPanel={() => setQueryPanelOpen((v) => !v)}
      />
    );
  }

  if (!filePath || !projectName) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary text-sm">
        <Database className="size-5 mr-2" /> No database file selected.
      </div>
    );
  }

  return (
    <SqliteViewerInner
      projectName={projectName}
      dbPath={filePath}
      queryPanelOpen={queryPanelOpen}
      onToggleQueryPanel={() => setQueryPanelOpen((v) => !v)}
    />
  );
}

function SqliteViewerInner({
  projectName, dbPath, connectionId, initialTable, queryPanelOpen, onToggleQueryPanel,
}: {
  projectName: string; dbPath: string; connectionId?: number; initialTable?: string;
  queryPanelOpen: boolean; onToggleQueryPanel: () => void;
}) {
  const sqlite = useSqlite(projectName, dbPath, connectionId);

  // Jump to initial table from sidebar click
  const [didInit, setDidInit] = useState(false);
  if (initialTable && !didInit && sqlite.tables.length > 0 && sqlite.selectedTable !== initialTable) {
    setDidInit(true);
    sqlite.selectTable(initialTable);
  }

  if (sqlite.error && sqlite.tables.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary">
        <AlertCircle className="size-10 text-destructive" />
        <p className="text-sm">{sqlite.error}</p>
      </div>
    );
  }

  if (sqlite.loading && sqlite.tables.length === 0) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-text-secondary">
        <Loader2 className="size-5 animate-spin" />
        <span className="text-sm">Loading database...</span>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Left sidebar — table list */}
      <SqliteTableList
        tables={sqlite.tables}
        selectedTable={sqlite.selectedTable}
        onSelect={sqlite.selectTable}
        onRefresh={sqlite.refreshTables}
      />

      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-hidden border-l border-border">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background shrink-0">
          <Database className="size-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground truncate">{dbPath}</span>
          <span className="text-xs text-muted-foreground">
            {sqlite.selectedTable && `/ ${sqlite.selectedTable}`}
          </span>
          <div className="ml-auto">
            <button
              type="button"
              onClick={onToggleQueryPanel}
              className={`px-2 py-1 rounded text-xs transition-colors ${queryPanelOpen ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              SQL
            </button>
          </div>
        </div>

        {/* Data grid */}
        <div className={`flex-1 overflow-hidden ${queryPanelOpen ? "max-h-[60%]" : ""}`}>
          <SqliteDataGrid
            tableData={sqlite.tableData}
            schema={sqlite.schema}
            loading={sqlite.loading}
            page={sqlite.page}
            onPageChange={sqlite.setPage}
            onCellUpdate={sqlite.updateCell}
          />
        </div>

        {/* Query editor (collapsible) */}
        {queryPanelOpen && (
          <div className="border-t border-border h-[40%] shrink-0">
            <SqliteQueryEditor
              onExecute={sqlite.executeQuery}
              result={sqlite.queryResult}
              error={sqlite.queryError}
              loading={sqlite.queryLoading}
            />
          </div>
        )}
      </div>
    </div>
  );
}
