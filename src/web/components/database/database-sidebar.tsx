import { useState } from "react";
import { Database, Plus } from "lucide-react";
import { SidebarHeader } from "@/components/ui/sidebar-header";
import { useTabStore } from "@/stores/tab-store";
import { ConnectionList } from "./connection-list";
import { ConnectionFormDialog } from "./connection-form-dialog";
import { ConnectionImportExport } from "./connection-import-export";
import { useConnections, type Connection, type CreateConnectionData, type UpdateConnectionData } from "./use-connections";

export function DatabaseSidebar() {
  const { connections, loading, cachedTables, refreshErrors, columnCache, createConnection, updateConnection, deleteConnection, testConnection, testRawConnection, refreshTables, fetchColumns, exportConnections, importConnections } = useConnections();
  const openTab = useTabStore((s) => s.openTab);
  const [addOpen, setAddOpen] = useState(false);
  const [editConn, setEditConn] = useState<Connection | null>(null);

  const handleOpenTable = (conn: Connection, tableName: string, schemaName: string) => {
    openTab({
      type: "database",
      title: `${conn.name} · ${tableName}`,
      projectId: null,
      closable: true,
      metadata: { connectionId: conn.id, connectionName: conn.name, dbType: conn.type, tableName, schemaName, connectionColor: conn.color },
    });
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this connection?")) return;
    try { await deleteConnection(id); } catch { /* server error — connection list will stay in sync on next fetch */ }
  };

  const handleCreate = async (data: CreateConnectionData) => {
    const created = await createConnection(data);
    // Auto-refresh tables after creating (use return value to avoid stale closure)
    if (created) refreshTables(created.id).catch(() => {});
  };

  const handleUpdate = async (id: number, data: UpdateConnectionData) => {
    await updateConnection(id, data);
  };

  return (
    <div className="flex flex-col h-full">
      <SidebarHeader icon={Database} title="Database">
        <ConnectionImportExport onExport={exportConnections} onImport={importConnections} />
        <button
          onClick={() => setAddOpen(true)}
          className="flex size-6 items-center justify-center rounded text-text-subtle hover:bg-surface-elevated hover:text-foreground"
          title="Add connection"
        >
          <Plus className="size-3.5" />
        </button>
      </SidebarHeader>

      {/* Connection list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <p className="px-4 py-6 text-xs text-text-subtle text-center">Loading…</p>
        ) : (
          <ConnectionList
            connections={connections}
            cachedTables={cachedTables}
            refreshErrors={refreshErrors}
            onOpenTable={handleOpenTable}
            onRefreshTables={refreshTables}
            onEdit={setEditConn}
            onDelete={handleDelete}
            onFetchColumns={fetchColumns}
            columnCache={columnCache}
          />
        )}
      </div>

      {/* Add dialog */}
      <ConnectionFormDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSave={handleCreate}
        onTest={() => Promise.resolve({ ok: false, error: "Save connection first" })}
        onTestRaw={testRawConnection}
      />

      {/* Edit dialog */}
      {editConn && (
        <ConnectionFormDialog
          open={!!editConn}
          onClose={() => setEditConn(null)}
          connection={editConn}
          onUpdate={handleUpdate}
          onTest={(id) => testConnection(id)}
        />
      )}
    </div>
  );
}
